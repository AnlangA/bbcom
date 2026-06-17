//! IPC contract tests for the AI-window command surface.
//!
//! The window commands (`show_ai_window`, `hide_ai_window`, `get_ai_window_state`,
//! `resize_ai_window`, `start_ai_window_drag`) take a `tauri::AppHandle`/`Window`
//! that cannot be built in a unit test, so these tests cover the contract layer
//! that CAN break silently: the exact frontend JSON wire shapes (camelCase) the
//! commands deserialize, the resize-clamp routing, and the `AiWindowState`
//! response serialization the frontend parses.

#[cfg(test)]
mod tests {
    use crate::commands::window::{
        AI_WINDOW_MAX_HEIGHT, AI_WINDOW_MIN_WIDTH, AiWindowState, ResizeAiWindowRequest,
        clamp_window_size,
    };

    // ipc.ts resizeAiWindow sends { request: { width, height } } (camelCase).
    #[test]
    fn resize_request_deserializes_frontend_camel_case_payload() {
        let json = r#"{"width":640.0,"height":300.0}"#;
        let req: ResizeAiWindowRequest = serde_json::from_str(json).expect("resize payload shape");
        assert_eq!(req.width, 640.0);
        assert_eq!(req.height, 300.0);
    }

    #[test]
    fn resize_request_rejects_missing_required_field() {
        // height is required (not Option); omitting it must fail to deserialize
        // rather than silently defaulting.
        let json = r#"{"width":640.0}"#;
        assert!(serde_json::from_str::<ResizeAiWindowRequest>(json).is_err());
    }

    // The command clamps the deserialized width/height before applying it; verify
    // the contract-level routing through clamp_window_size matches the bounds the
    // frontend relies on.
    #[test]
    fn resize_payload_routes_through_the_clamp_range() {
        let req: ResizeAiWindowRequest =
            serde_json::from_str(r#"{"width":50.0,"height":5000.0}"#).unwrap();
        let (w, h) = clamp_window_size(req.width, req.height);
        assert_eq!(w, AI_WINDOW_MIN_WIDTH, "width clamped to min");
        assert_eq!(h, AI_WINDOW_MAX_HEIGHT, "height clamped to max");
    }

    // get_ai_window_state returns { visible: bool } (camelCase); the frontend's
    // AiWindowState TS interface reads `.visible`. Confirm the serde shape.
    #[test]
    fn ai_window_state_serializes_to_frontend_camel_case() {
        let state = AiWindowState { visible: true };
        let json = serde_json::to_string(&state).unwrap();
        assert_eq!(
            json, r#"{"visible":true}"#,
            "camelCase key, no extra fields"
        );

        let hidden = AiWindowState { visible: false };
        assert_eq!(
            serde_json::to_string(&hidden).unwrap(),
            r#"{"visible":false}"#
        );
    }

    // The show/hide commands emit `ai-window-state` with this payload; lock the
    // emitted event shape the frontend listens for.
    #[test]
    fn window_state_event_payload_matches_emitted_camel_case() {
        let emitted = serde_json::to_string(&AiWindowState { visible: true }).unwrap();
        assert_eq!(emitted, r#"{"visible":true}"#);
    }
}
