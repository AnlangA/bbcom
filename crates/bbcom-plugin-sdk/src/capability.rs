#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    UiWorkspace,
    UiDetachedWindow,
    SerialPortsRead,
    SerialSessionsManage,
    SerialIo,
    SerialControlLines,
    SessionCaptureRead,
    SessionCommandsReadWrite,
    FileOpenRead,
    FileSaveWrite,
    PluginStorage,
    ProjectStateReadWrite,
}

impl Capability {
    pub const ALL: [Self; 12] = [
        Self::UiWorkspace,
        Self::UiDetachedWindow,
        Self::SerialPortsRead,
        Self::SerialSessionsManage,
        Self::SerialIo,
        Self::SerialControlLines,
        Self::SessionCaptureRead,
        Self::SessionCommandsReadWrite,
        Self::FileOpenRead,
        Self::FileSaveWrite,
        Self::PluginStorage,
        Self::ProjectStateReadWrite,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UiWorkspace => "ui.workspace",
            Self::UiDetachedWindow => "ui.detached-window",
            Self::SerialPortsRead => "serial.ports.read",
            Self::SerialSessionsManage => "serial.sessions.manage",
            Self::SerialIo => "serial.io",
            Self::SerialControlLines => "serial.control-lines",
            Self::SessionCaptureRead => "session.capture.read",
            Self::SessionCommandsReadWrite => "session.commands.read-write",
            Self::FileOpenRead => "file.open-read",
            Self::FileSaveWrite => "file.save-write",
            Self::PluginStorage => "plugin.storage",
            Self::ProjectStateReadWrite => "project.state.read-write",
        }
    }
}
