use crate::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress<'a> {
    pub task_id: &'a str,
    pub completed: u64,
    pub total: Option<u64>,
    pub message: &'a str,
}

/// Supplied by generated WIT glue for long-running guest commands. A command
/// should call `checkpoint` between chunks; the host enforces its 30-second
/// activity deadline and two-hour task maximum independently.
pub trait TaskContext {
    fn is_cancelled(&self) -> bool;
    fn progress(&mut self, value: Progress<'_>) -> Result<()>;
    fn heartbeat(&mut self, task_id: &str) -> Result<()>;

    fn checkpoint(&mut self, task_id: &str) -> Result<()> {
        if self.is_cancelled() {
            Err(crate::ContractError::Cancelled)
        } else {
            self.heartbeat(task_id)
        }
    }
}
