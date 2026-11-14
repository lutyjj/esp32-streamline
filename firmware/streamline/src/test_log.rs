//! Host tests of logging: a test thread reads back the records it logged.

use std::{cell::RefCell, sync::Once};

use log::{LevelFilter, Log, Metadata, Record};

thread_local! {
    static LINES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

struct ThreadLog;

impl Log for ThreadLog {
    fn enabled(&self, _metadata: &Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &Record<'_>) {
        let line = format!("{} {}", record.level(), record.args());
        let _ = LINES.try_with(|lines| lines.borrow_mut().push(line));
    }

    fn flush(&self) {}
}

static LOGGER: ThreadLog = ThreadLog;
static INSTALL: Once = Once::new();

/// Run `action` and return it with the lines this thread logged meanwhile.
pub fn logged_lines<R>(action: impl FnOnce() -> R) -> (R, Vec<String>) {
    INSTALL.call_once(|| {
        log::set_logger(&LOGGER).expect("only host tests install a logger");
        log::set_max_level(LevelFilter::Trace);
    });
    LINES.with_borrow_mut(Vec::clear);
    let result = action();
    (result, LINES.take())
}
