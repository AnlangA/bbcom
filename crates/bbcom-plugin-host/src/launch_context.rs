/// Identity and workspace routing data for one plugin launch.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginLaunchContext {
    pub workspace_id: String,
    pub instance_id: String,
    pub generation: u64,
}
