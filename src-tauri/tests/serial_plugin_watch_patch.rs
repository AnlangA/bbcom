use tauri_plugin_serialplugin::events::SerialEvent;
use tauri_plugin_serialplugin::hub::shared::{HubRoutingState, route_watch_chunk};

#[test]
fn native_watch_preserves_line_endings_empty_lines_and_binary_bytes() {
    let mut state = HubRoutingState::new("COM1".to_string());
    let chunks: &[&[u8]] = &[b"first\r", b"\n\r\nsecond\n", &[0xff, 0x00, b'\r', b'\n']];

    for chunk in chunks {
        route_watch_chunk("COM1", chunk, &mut state);
    }

    assert_eq!(state.combined_buffer, b"first\r\n\r\nsecond\n\xff\x00\r\n");
}

#[test]
fn native_watch_keeps_urc_bytes_in_data_while_publishing_a_notification() {
    let mut state = HubRoutingState::new("COM1".to_string());
    let raw = b"^CARDLOCK: 1\r\n";

    route_watch_chunk("COM1", raw, &mut state);

    assert_eq!(state.combined_buffer, raw);
    assert!(
        state
            .pending_events
            .iter()
            .any(|event| matches!(event, SerialEvent::Urc { line, .. } if line == "^CARDLOCK: 1"))
    );
}
