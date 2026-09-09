//! ESP-IDF thread configuration and cancellable task reservation.

use anyhow::{Context, Result};
use esp_idf_svc::hal::task::thread::ThreadSpawnConfiguration;

use crate::task_start::PendingTask;

pub fn prepare(
    config: ThreadSpawnConfiguration,
    task: impl FnOnce() + Send + 'static,
) -> Result<PendingTask> {
    let previous = ThreadSpawnConfiguration::get();
    config.set().context("cannot configure task")?;
    let pending = PendingTask::spawn(
        std::thread::Builder::new().stack_size(config.stack_size),
        task,
    )
    .context("cannot reserve task");
    previous
        .unwrap_or_default()
        .set()
        .context("cannot restore task configuration")?;
    pending
}
