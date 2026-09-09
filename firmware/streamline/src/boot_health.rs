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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

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
