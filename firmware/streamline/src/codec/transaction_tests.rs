//! Register-boundary failure injection through the production codec controller.

use super::{CodecControl, Driver, RegisterBus};
use crate::{
    analog_passthrough::{AnalogPassthroughControl, AnalogPassthroughRoute},
    config::AudioSettings,
    mutation::MutationError,
};
use anyhow::{bail, Result};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

#[derive(Default)]
struct BusState {
    registers: BTreeMap<u8, u8>,
    writes: usize,
    fail_at: BTreeSet<usize>,
    events: Vec<(u8, u8)>,
    settled_after: Vec<(usize, u32)>,
}

#[derive(Clone, Default)]
struct FakeBus(Rc<RefCell<BusState>>);

impl RegisterBus for FakeBus {
    fn write(&mut self, register: u8, value: u8) -> Result<()> {
        let mut state = self.0.borrow_mut();
        state.writes += 1;
        state.events.push((register, value));
        if state.fail_at.contains(&state.writes) {
            bail!("injected bus failure");
        }
        state.registers.insert(register, value);
        Ok(())
    }
    fn delay_ms(&mut self, millis: u32) {
        let mut state = self.0.borrow_mut();
        let writes = state.writes;
        state.settled_after.push((writes, millis));
    }
}

const BEFORE: AudioSettings = AudioSettings {
    input_line: 1,
    input_gain: 0,
    adc_attenuation_db: 0,
};
const AFTER: AudioSettings = AudioSettings {
    input_line: 2,
    input_gain: 100,
    adc_attenuation_db: 48,
};

fn running(passthrough: bool) -> (CodecControl<FakeBus>, FakeBus) {
    let bus = FakeBus::default();
    let mut codec = CodecControl::new(bus.clone(), Driver::Es8388, BEFORE).unwrap();
    if passthrough {
        codec
            .enable(AnalogPassthroughRoute {
                input_line: 1,
                output_line: 2,
            })
            .unwrap();
    }
    bus.0.borrow_mut().writes = 0;
    bus.0.borrow_mut().events.clear();
    bus.0.borrow_mut().settled_after.clear();
    (codec, bus)
}

#[test]
fn every_partial_audio_apply_restores_hardware_without_committing() {
    for (passthrough, writes) in [(false, 4), (true, 7)] {
        for boundary in 1..=writes {
            let (mut codec, bus) = running(passthrough);
            let before = bus.0.borrow().registers.clone();
            bus.0.borrow_mut().fail_at.insert(boundary);
            let error = codec
                .change_audio(AFTER, || panic!("failed hardware cannot commit"))
                .unwrap_err();
            assert!(
                error.rollback_error.is_none(),
                "boundary {boundary}: {error:?}"
            );
            assert_eq!(bus.0.borrow().registers, before, "boundary {boundary}");
            assert_eq!(codec.passthrough_active(), passthrough);
        }
    }
}

#[test]
fn persistence_runs_after_hardware_and_failure_restores_audio_and_route() {
    let (mut codec, bus) = running(true);
    let before = bus.0.borrow().registers.clone();
    let error = codec
        .change_audio(AFTER, || {
            let registers = &bus.0.borrow().registers;
            assert_eq!(registers[&0x09], 0x88);
            assert_eq!(registers[&0x0a], 0x50);
            assert_eq!(registers[&0x10], 96);
            assert_eq!(registers[&0x11], 96);
            assert_eq!(registers[&0x26], 0x09);
            Err(MutationError::Persistence(
                "injected storage failure".into(),
            ))
        })
        .unwrap_err();
    assert!(matches!(error.cause, MutationError::Persistence(_)));
    assert!(error.rollback_error.is_none());
    assert_eq!(bus.0.borrow().registers, before);
    assert!(codec.passthrough_active());
}

#[test]
fn rollback_failure_requires_a_streaming_pause_and_closes_local_output() {
    let (mut codec, bus) = running(false);
    bus.0.borrow_mut().fail_at.extend([2, 3]);
    let error = codec
        .change_audio(AFTER, || panic!("failed hardware cannot commit"))
        .unwrap_err();
    assert!(error
        .rollback_error
        .unwrap()
        .contains("streaming is paused"));
    assert!(!codec.passthrough_active());
    assert_eq!(bus.0.borrow().registers[&0x04], 0);
}

#[test]
fn input_switch_mutes_and_settles_before_unmuting() {
    let (mut codec, bus) = running(true);
    codec.change_audio(AFTER, || Ok(())).unwrap();
    let state = bus.0.borrow();
    assert_eq!(state.events.first(), Some(&(0x19, 0x04)));
    assert_eq!(state.events.last(), Some(&(0x19, 0x00)));
    assert_eq!(state.settled_after, [(state.writes - 1, 100)]);
}

#[test]
fn disable_attempts_every_close_write_after_a_bus_error() {
    let (mut codec, bus) = running(true);
    bus.0.borrow_mut().fail_at.insert(1);
    assert!(codec.disable().is_err());
    assert_eq!(
        bus.0.borrow().events,
        [(0x19, 4), (0x04, 0), (0x27, 0x90), (0x2a, 0x90)]
    );
    assert!(!codec.passthrough_active());
}

#[test]
fn every_initialization_failure_attempts_to_close_the_output() {
    let baseline = FakeBus::default();
    CodecControl::new(baseline.clone(), Driver::Es8388, BEFORE).unwrap();
    let writes = baseline.0.borrow().writes;
    for boundary in 1..=writes {
        let bus = FakeBus::default();
        bus.0.borrow_mut().fail_at.insert(boundary);
        assert!(CodecControl::new(bus.clone(), Driver::Es8388, BEFORE).is_err());
        assert_eq!(bus.0.borrow().writes, boundary + 4);
        assert_eq!(bus.0.borrow().registers[&0x04], 0);
    }
}
