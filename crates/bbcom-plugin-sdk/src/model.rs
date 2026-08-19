//! Helpers for the protocol-v2 initialization declaration transaction.

/// Host-import adapter used by [`register_initial_model`].
///
/// Implement this over the generated WIT host bindings. Registration must be
/// completed before the guest publishes a surface snapshot. The guest must
/// then return a `plugin-model` containing these exact declarations in its
/// `initialize` response; the host validates both views before committing any
/// staged plugin or project state.
pub trait InitialModelRegistrar<Surface, Command> {
    type Error;

    fn register_surface(&mut self, surface: &Surface) -> Result<(), Self::Error>;
    fn register_command(&mut self, command: &Command) -> Result<(), Self::Error>;
}

/// Registers one initial model in deterministic surface-then-command order.
///
/// The slices remain owned by the guest so the same values can be used to
/// construct the exported `plugin-model`; this avoids a second independently
/// assembled declaration set drifting from the host-import registrations.
pub fn register_initial_model<Surface, Command, Registrar>(
    registrar: &mut Registrar,
    surfaces: &[Surface],
    commands: &[Command],
) -> Result<(), Registrar::Error>
where
    Registrar: InitialModelRegistrar<Surface, Command>,
{
    for surface in surfaces {
        registrar.register_surface(surface)?;
    }
    for command in commands {
        registrar.register_command(command)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{InitialModelRegistrar, register_initial_model};

    #[derive(Default)]
    struct RecordingRegistrar(Vec<u8>);

    impl InitialModelRegistrar<u8, u8> for RecordingRegistrar {
        type Error = ();

        fn register_surface(&mut self, surface: &u8) -> Result<(), Self::Error> {
            self.0.push(*surface);
            Ok(())
        }

        fn register_command(&mut self, command: &u8) -> Result<(), Self::Error> {
            self.0.push(*command);
            Ok(())
        }
    }

    #[test]
    fn initial_model_registration_is_deterministic() {
        let mut registrar = RecordingRegistrar::default();
        register_initial_model(&mut registrar, &[1, 2], &[3, 4]).unwrap();
        assert_eq!(registrar.0, [1, 2, 3, 4]);
    }
}
