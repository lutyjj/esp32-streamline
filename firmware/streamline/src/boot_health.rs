//! Management-plane proof required before confirming pending firmware.

use crate::{api, mode::Mode};

pub const PROBES: [api::Endpoint; 2] = [api::STATUS, api::SETTINGS];

pub fn start<T, E>(
    mode: Mode,
    start_server: impl FnOnce() -> Result<T, E>,
    mut probe: impl FnMut(api::Endpoint) -> Result<(), E>,
    confirm: impl FnOnce() -> Result<(), E>,
) -> Result<T, E> {
    let server = start_server()?;
    if mode == Mode::Provisioned {
        for endpoint in PROBES {
            probe(endpoint)?;
        }
        confirm()?;
    }
    Ok(server)
}

/// Setup never confirms at startup, so the reboot after commissioning would roll
/// back an update that left the device unconfigured. A setup-mode commissioning
/// write confirms the running image first; other modes confirm elsewhere.
pub fn confirm_before_commissioning<E>(
    mode: Mode,
    confirm: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    if mode != Mode::Setup {
        return Ok(());
    }
    confirm()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn setup_commissioning_confirms_the_running_image() {
        let confirmed = Cell::new(0);
        let result = confirm_before_commissioning(Mode::Setup, || {
            confirmed.set(confirmed.get() + 1);
            Ok::<_, ()>(())
        });
        assert_eq!(result, Ok(()));
        assert_eq!(confirmed.get(), 1);
    }

    #[test]
    fn recovery_and_provisioned_writes_never_confirm() {
        for mode in [Mode::Recovery, Mode::Provisioned] {
            let result =
                confirm_before_commissioning(mode, || -> Result<(), ()> { panic!("confirm") });
            assert_eq!(result, Ok(()));
        }
    }

    #[test]
    fn a_failed_confirmation_is_reported() {
        let result = confirm_before_commissioning(Mode::Setup, || Err("flash"));
        assert_eq!(result, Err("flash"));
    }

    #[test]
    fn startup_and_each_probe_failure_leave_firmware_unconfirmed() {
        for failure in 0..=PROBES.len() {
            let confirmed = Cell::new(false);
            let mut step = 0;
            let result = start(
                Mode::Provisioned,
                || if failure == 0 { Err(()) } else { Ok(()) },
                |_| {
                    step += 1;
                    if step == failure {
                        Err(())
                    } else {
                        Ok(())
                    }
                },
                || {
                    confirmed.set(true);
                    Ok(())
                },
            );
            assert_eq!(result, Err(()));
            assert!(!confirmed.get());
        }
    }

    #[test]
    fn confirmation_follows_every_management_probe() {
        let probes = Cell::new(0);
        start(
            Mode::Provisioned,
            || Ok::<_, ()>(()),
            |_| {
                probes.set(probes.get() + 1);
                Ok(())
            },
            || {
                assert_eq!(probes.get(), PROBES.len());
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn setup_and_recovery_serve_without_confirming() {
        for mode in [Mode::Setup, Mode::Recovery] {
            start(
                mode,
                || Ok::<_, ()>(()),
                |_| panic!("probe"),
                || panic!("confirm"),
            )
            .unwrap();
        }
    }
}
