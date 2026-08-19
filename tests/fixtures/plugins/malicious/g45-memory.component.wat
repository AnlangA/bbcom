(component
  (type $ty-bbcom:plugin/types@2.0.0 (;0;)
    (instance
      (type (;0;) (list string))
      (type (;1;) (record (field "command-id" string) (field "invocation-id" string) (field "arguments" 0)))
      (export (;2;) "command-invocation" (type (eq 1)))
      (type (;3;) (record (field "message" string)))
      (export (;4;) "command-result" (type (eq 3)))
      (type (;5;) (enum "invalid-input" "permission-denied" "unavailable" "busy" "not-found" "stale-handle" "disconnected" "timeout" "cancelled" "limit-exceeded" "partial-write" "unknown-outcome" "protocol-error" "io-error"))
      (export (;6;) "contract-error" (type (eq 5)))
      (type (;7;) (record (field "accepted" bool)))
      (export (;8;) "event-result" (type (eq 7)))
      (type (;9;) (enum "light" "dark" "system"))
      (export (;10;) "color-scheme" (type (eq 9)))
      (type (;11;) (enum "ui-workspace" "ui-detached-window" "serial-ports-read" "serial-sessions-manage" "serial-io" "serial-control-lines" "session-capture-read" "session-commands-read-write" "file-open-read" "file-save-write" "plugin-storage" "project-state-read-write"))
      (export (;12;) "capability" (type (eq 11)))
      (type (;13;) (record (field "max-frame-bytes" u64) (field "max-queue-bytes" u64) (field "max-stream-chunk-bytes" u32) (field "max-concurrent-streams" u32) (field "max-pending-host-requests" u32) (field "wasm-memory-limit-bytes" u64) (field "host-process-memory-limit-bytes" u64) (field "call-timeout-ms" u32) (field "serial-read-timeout-ms" u32) (field "long-task-timeout-ms" u64) (field "activity-timeout-ms" u32) (field "max-ui-document-bytes" u32) (field "max-ui-nodes" u32)))
      (export (;14;) "resource-limits" (type (eq 13)))
      (type (;15;) (record (field "session-id" string) (field "name" string) (field "connected" bool) (field "rx-bytes" u64) (field "tx-bytes" u64) (field "generation" u64)))
      (export (;16;) "session-summary" (type (eq 15)))
      (type (;17;) (list 12))
      (type (;18;) (list 16))
      (type (;19;) (record (field "workspace-id" string) (field "plugin-id" string) (field "instance-id" string) (field "generation" u64) (field "locale" string) (field "theme" 10) (field "granted-capabilities" 17) (field "limits" 14) (field "sessions" 18)))
      (export (;20;) "host-context" (type (eq 19)))
      (type (;21;) (list u8))
      (type (;22;) (record (field "schema-version" u32) (field "state" 21)))
      (export (;23;) "migrated-state" (type (eq 22)))
      (type (;24;) (variant (case "text" string) (case "number" f64) (case "toggle" bool) (case "selection" string) (case "action")))
      (export (;25;) "ui-value" (type (eq 24)))
      (type (;26;) (record (field "surface-id" string) (field "revision" u64) (field "node-id" string) (field "value" 25)))
      (export (;27;) "surface-interaction" (type (eq 26)))
      (type (;28;) (variant (case "surface" 27) (case "locale-changed" string) (case "theme-changed" 10) (case "port-catalog-changed") (case "cancel-task" string)))
      (export (;29;) "plugin-event" (type (eq 28)))
      (type (;30;) (enum "workspace" "detached-window"))
      (export (;31;) "surface-location" (type (eq 30)))
      (type (;32;) (record (field "surface-id" string) (field "title" string) (field "location" 31)))
      (export (;33;) "plugin-surface" (type (eq 32)))
      (type (;34;) (option string))
      (type (;35;) (record (field "command-id" string) (field "title" string) (field "description" string) (field "long-running" bool) (field "confirmation" 34)))
      (export (;36;) "command-contribution" (type (eq 35)))
      (type (;37;) (list 33))
      (type (;38;) (list 36))
      (type (;39;) (record (field "surfaces" 37) (field "commands" 38)))
      (export (;40;) "plugin-model" (type (eq 39)))
    )
  )
  (import "bbcom:plugin/types@2.0.0" (instance $bbcom:plugin/types@2.0.0 (;0;) (type $ty-bbcom:plugin/types@2.0.0)))
  (alias export $bbcom:plugin/types@2.0.0 "command-invocation" (type $command-invocation (;1;)))
  (import "command-invocation" (type $"#type2 command-invocation" (@name "command-invocation") (;2;) (eq $command-invocation)))
  (alias export $bbcom:plugin/types@2.0.0 "command-result" (type $command-result (;3;)))
  (import "command-result" (type $"#type4 command-result" (@name "command-result") (;4;) (eq $command-result)))
  (alias export $bbcom:plugin/types@2.0.0 "contract-error" (type $contract-error (;5;)))
  (import "contract-error" (type $"#type6 contract-error" (@name "contract-error") (;6;) (eq $contract-error)))
  (alias export $bbcom:plugin/types@2.0.0 "event-result" (type $event-result (;7;)))
  (import "event-result" (type $"#type8 event-result" (@name "event-result") (;8;) (eq $event-result)))
  (alias export $bbcom:plugin/types@2.0.0 "host-context" (type $host-context (;9;)))
  (import "host-context" (type $"#type10 host-context" (@name "host-context") (;10;) (eq $host-context)))
  (alias export $bbcom:plugin/types@2.0.0 "migrated-state" (type $migrated-state (;11;)))
  (import "migrated-state" (type $"#type12 migrated-state" (@name "migrated-state") (;12;) (eq $migrated-state)))
  (alias export $bbcom:plugin/types@2.0.0 "plugin-event" (type $plugin-event (;13;)))
  (import "plugin-event" (type $"#type14 plugin-event" (@name "plugin-event") (;14;) (eq $plugin-event)))
  (alias export $bbcom:plugin/types@2.0.0 "plugin-model" (type $plugin-model (;15;)))
  (import "plugin-model" (type $"#type16 plugin-model" (@name "plugin-model") (;16;) (eq $plugin-model)))
  (core module $main (;0;)
    (type (;0;) (func))
    (type (;1;) (func (param i32)))
    (type (;2;) (func (param i32 i32 i32 i32 i32)))
    (type (;3;) (func (param i32 i32)))
    (type (;4;) (func (param i32 i32 i32 i32 i32 i32)))
    (type (;5;) (func (param i32 i32 i32 i32) (result i32)))
    (type (;6;) (func (param i32 i32) (result i32)))
    (type (;7;) (func (param i32 i32 i32 i64 i32 i32 i32 i64 i32) (result i32)))
    (type (;8;) (func (param i32) (result i32)))
    (type (;9;) (func (param i32 i32 i32 i32 i32 i32) (result i32)))
    (type (;10;) (func (param i32 i32 i32) (result i32)))
    (table (;0;) 2 2 funcref)
    (memory (;0;) 659)
    (global (;0;) (mut i32) i32.const 1048576)
    (global (;1;) i32 i32.const 0)
    (export "memory" (memory 0))
    (export "cabi_post_initialize" (func 14))
    (export "cabi_post_migrate-state" (func 15))
    (export "cabi_post_run-command" (func 16))
    (export "handle-event" (func 17))
    (export "initialize" (func 18))
    (export "migrate-state" (func 20))
    (export "run-command" (func 21))
    (export "shutdown" (func 22))
    (export "cabi_realloc" (func 23))
    (export "memcmp" (func 24))
    (elem (;0;) (i32.const 1) func 2)
    (func (;0;) (type 0))
    (func (;1;) (type 0)
      i32.const 1024
      memory.grow
      drop
      unreachable
    )
    (func (;2;) (type 0))
    (func (;3;) (type 1) (param i32)
      (local i32)
      global.get 0
      i32.const 16
      i32.sub
      local.tee 1
      global.set 0
      local.get 1
      i32.const 8
      i32.add
      local.get 0
      local.get 0
      i32.load
      i32.const 4
      i32.const 12
      call 4
      block ;; label = @1
        local.get 1
        i32.load offset=8
        local.tee 0
        i32.const -1
        i32.eq
        br_if 0 (;@1;)
        local.get 0
        local.get 1
        i32.load offset=12
        call 5
        unreachable
      end
      local.get 1
      i32.const 16
      i32.add
      global.set 0
    )
    (func (;4;) (type 2) (param i32 i32 i32 i32 i32)
      (local i32 i32)
      global.get 0
      i32.const 16
      i32.sub
      local.tee 5
      global.set 0
      local.get 5
      i32.const 4
      i32.add
      local.get 1
      i32.load
      local.tee 6
      local.get 1
      i32.load offset=4
      local.get 2
      i32.const 1
      i32.add
      local.tee 2
      local.get 6
      i32.const 1
      i32.shl
      local.tee 6
      local.get 2
      local.get 6
      i32.gt_u
      select
      local.tee 2
      i32.const 8
      i32.const 4
      local.get 4
      i32.const 1
      i32.eq
      select
      local.tee 6
      local.get 2
      local.get 6
      i32.gt_u
      select
      local.tee 2
      local.get 3
      local.get 4
      call 8
      block ;; label = @1
        block ;; label = @2
          local.get 5
          i32.load offset=4
          i32.eqz
          br_if 0 (;@2;)
          local.get 5
          i32.load offset=12
          local.set 1
          local.get 5
          i32.load offset=8
          local.set 4
          br 1 (;@1;)
        end
        local.get 5
        i32.load offset=8
        local.set 4
        local.get 1
        local.get 2
        i32.store
        local.get 1
        local.get 4
        i32.store offset=4
        i32.const -1
        local.set 4
      end
      local.get 0
      local.get 1
      i32.store offset=4
      local.get 0
      local.get 4
      i32.store
      local.get 5
      i32.const 16
      i32.add
      global.set 0
    )
    (func (;5;) (type 3) (param i32 i32)
      block ;; label = @1
        local.get 0
        i32.eqz
        br_if 0 (;@1;)
        call 13
        unreachable
      end
      call 19
      unreachable
    )
    (func (;6;) (type 1) (param i32)
      (local i32)
      global.get 0
      i32.const 16
      i32.sub
      local.tee 1
      global.set 0
      local.get 1
      i32.const 8
      i32.add
      local.get 0
      local.get 0
      i32.load
      i32.const 1
      i32.const 1
      call 4
      block ;; label = @1
        local.get 1
        i32.load offset=8
        local.tee 0
        i32.const -1
        i32.eq
        br_if 0 (;@1;)
        local.get 0
        local.get 1
        i32.load offset=12
        call 5
        unreachable
      end
      local.get 1
      i32.const 16
      i32.add
      global.set 0
    )
    (func (;7;) (type 1) (param i32)
      (local i32)
      global.get 0
      i32.const 16
      i32.sub
      local.tee 1
      global.set 0
      local.get 1
      i32.const 8
      i32.add
      local.get 0
      local.get 0
      i32.load
      i32.const 8
      i32.const 56
      call 4
      block ;; label = @1
        local.get 1
        i32.load offset=8
        local.tee 0
        i32.const -1
        i32.eq
        br_if 0 (;@1;)
        local.get 0
        local.get 1
        i32.load offset=12
        call 5
        unreachable
      end
      local.get 1
      i32.const 16
      i32.add
      global.set 0
    )
    (func (;8;) (type 4) (param i32 i32 i32 i32 i32 i32)
      (local i32 i32 i64)
      i32.const 1
      local.set 6
      i32.const 4
      local.set 7
      block ;; label = @1
        block ;; label = @2
          local.get 5
          i64.extend_i32_u
          local.get 3
          i64.extend_i32_u
          i64.mul
          local.tee 8
          i64.const 32
          i64.shr_u
          i32.wrap_i64
          br_if 0 (;@2;)
          local.get 8
          i32.wrap_i64
          local.tee 3
          i32.const -2147483648
          local.get 4
          i32.sub
          i32.gt_u
          br_if 0 (;@2;)
          block ;; label = @3
            block ;; label = @4
              block ;; label = @5
                block ;; label = @6
                  local.get 1
                  i32.eqz
                  br_if 0 (;@6;)
                  local.get 2
                  local.get 1
                  local.get 5
                  i32.mul
                  local.get 4
                  local.get 3
                  call 9
                  local.set 7
                  br 1 (;@5;)
                end
                block ;; label = @6
                  local.get 3
                  br_if 0 (;@6;)
                  local.get 4
                  local.set 7
                  br 2 (;@4;)
                end
                local.get 4
                local.get 3
                call 10
                local.set 7
              end
              local.get 7
              br_if 0 (;@4;)
              local.get 0
              local.get 4
              i32.store offset=4
              br 1 (;@3;)
            end
            local.get 0
            local.get 7
            i32.store offset=4
            i32.const 0
            local.set 6
          end
          i32.const 8
          local.set 7
          br 1 (;@1;)
        end
        i32.const 0
        local.set 3
      end
      local.get 0
      local.get 7
      i32.add
      local.get 3
      i32.store
      local.get 0
      local.get 6
      i32.store
    )
    (func (;9;) (type 5) (param i32 i32 i32 i32) (result i32)
      block ;; label = @1
        local.get 2
        local.get 3
        call 10
        local.tee 2
        i32.eqz
        br_if 0 (;@1;)
        block ;; label = @2
          local.get 3
          local.get 1
          local.get 3
          local.get 1
          i32.lt_u
          select
          local.tee 3
          i32.eqz
          br_if 0 (;@2;)
          local.get 2
          local.get 0
          local.get 3
          memory.copy
        end
        local.get 0
        local.get 1
        call 12
      end
      local.get 2
    )
    (func (;10;) (type 6) (param i32 i32) (result i32)
      (local i32 i32 i32)
      block ;; label = @1
        local.get 1
        i32.eqz
        br_if 0 (;@1;)
        loop ;; label = @2
          global.get 1
          i32.const 1163284
          i32.add
          local.tee 2
          local.get 2
          i32.load8_u
          local.tee 2
          i32.const 1
          local.get 2
          select
          i32.store8
          local.get 2
          br_if 0 (;@2;)
        end
        i32.const 0
        local.set 2
        block ;; label = @2
          loop ;; label = @3
            block ;; label = @4
              global.get 1
              i32.const 1114132
              i32.add
              local.get 2
              i32.add
              local.tee 3
              i32.const 8
              i32.add
              i32.load8_u
              i32.eqz
              br_if 0 (;@4;)
              local.get 3
              i32.load
              local.set 3
              global.get 1
              i32.const 1114132
              i32.add
              local.get 2
              i32.add
              i32.const 4
              i32.add
              i32.load
              local.get 1
              i32.lt_u
              br_if 0 (;@4;)
              local.get 3
              local.get 0
              i32.rem_u
              br_if 0 (;@4;)
              global.get 1
              local.tee 1
              i32.const 1114132
              i32.add
              local.get 2
              i32.add
              i32.const 8
              i32.add
              i32.const 0
              i32.store8
              local.get 1
              i32.const 1179648
              i32.add
              local.get 3
              i32.add
              local.set 4
              br 2 (;@2;)
            end
            local.get 2
            i32.const 12
            i32.add
            local.tee 2
            i32.const 49152
            i32.ne
            br_if 0 (;@3;)
          end
          i32.const 0
          local.set 4
          local.get 0
          global.get 1
          i32.const 43122688
          i32.add
          i32.load
          i32.add
          i32.const -1
          i32.add
          i32.const 0
          local.get 0
          i32.sub
          i32.and
          local.tee 2
          local.get 1
          i32.add
          local.tee 3
          local.get 2
          i32.lt_u
          br_if 0 (;@2;)
          local.get 3
          i32.const 41943040
          i32.gt_u
          br_if 0 (;@2;)
          global.get 1
          local.tee 1
          i32.const 1163284
          i32.add
          i32.const 0
          i32.store8
          local.get 1
          i32.const 43122688
          i32.add
          local.get 3
          i32.store
          local.get 1
          i32.const 1179648
          i32.add
          local.get 2
          i32.add
          return
        end
        global.get 1
        i32.const 1163284
        i32.add
        i32.const 0
        i32.store8
        local.get 4
        return
      end
      local.get 0
    )
    (func (;11;) (type 3) (param i32 i32)
      (local i32 i32)
      block ;; label = @1
        block ;; label = @2
          block ;; label = @3
            local.get 1
            i32.load
            local.tee 2
            local.get 1
            i32.load offset=8
            local.tee 3
            i32.gt_u
            br_if 0 (;@3;)
            local.get 1
            i32.load offset=4
            local.set 1
            br 1 (;@2;)
          end
          local.get 1
          i32.load offset=4
          local.set 1
          block ;; label = @3
            local.get 3
            br_if 0 (;@3;)
            local.get 1
            local.get 2
            call 12
            i32.const 1
            local.set 1
            br 1 (;@2;)
          end
          local.get 1
          local.get 2
          i32.const 1
          local.get 3
          call 9
          local.tee 1
          i32.eqz
          br_if 1 (;@1;)
        end
        local.get 0
        local.get 3
        i32.store offset=4
        local.get 0
        local.get 1
        i32.store
        return
      end
      call 13
      unreachable
    )
    (func (;12;) (type 3) (param i32 i32)
      (local i32 i32 i32 i32)
      block ;; label = @1
        local.get 0
        i32.eqz
        br_if 0 (;@1;)
        local.get 1
        i32.eqz
        br_if 0 (;@1;)
        loop ;; label = @2
          global.get 1
          i32.const 1163284
          i32.add
          local.tee 2
          local.get 2
          i32.load8_u
          local.tee 2
          i32.const 1
          local.get 2
          select
          i32.store8
          local.get 2
          br_if 0 (;@2;)
        end
        block ;; label = @2
          local.get 0
          global.get 1
          i32.const 1179648
          i32.add
          i32.lt_u
          br_if 0 (;@2;)
          local.get 1
          local.get 0
          i32.add
          local.tee 2
          local.get 1
          i32.lt_u
          br_if 0 (;@2;)
          local.get 2
          global.get 1
          i32.const 1179648
          i32.add
          i32.const 41943040
          i32.add
          i32.gt_u
          br_if 0 (;@2;)
          i32.const 0
          local.set 2
          loop ;; label = @3
            local.get 2
            i32.const 12
            i32.add
            local.tee 3
            i32.const 49164
            i32.eq
            br_if 1 (;@2;)
            global.get 1
            i32.const 1114132
            i32.add
            local.tee 4
            local.get 2
            i32.add
            local.set 5
            local.get 3
            local.set 2
            local.get 5
            i32.const 8
            i32.add
            i32.load8_u
            br_if 0 (;@3;)
          end
          local.get 4
          local.get 3
          i32.add
          i32.const -12
          i32.add
          local.tee 2
          i32.const 1
          i32.store8 offset=8
          local.get 2
          local.get 1
          i32.store offset=4
          local.get 2
          local.get 0
          global.get 1
          i32.const 1179648
          i32.add
          i32.sub
          i32.store
        end
        global.get 1
        i32.const 1163284
        i32.add
        i32.const 0
        i32.store8
      end
    )
    (func (;13;) (type 0)
      unreachable
    )
    (func (;14;) (type 1) (param i32)
      (local i32 i32 i32 i32 i32)
      block ;; label = @1
        local.get 0
        i32.load8_u
        br_if 0 (;@1;)
        block ;; label = @2
          local.get 0
          i32.load offset=8
          local.tee 1
          i32.eqz
          br_if 0 (;@2;)
          local.get 1
          local.set 2
          local.get 0
          i32.load offset=4
          local.tee 3
          local.set 4
          loop ;; label = @3
            block ;; label = @4
              local.get 4
              i32.const 4
              i32.add
              i32.load
              local.tee 5
              i32.eqz
              br_if 0 (;@4;)
              local.get 4
              i32.load
              local.get 5
              call 12
            end
            block ;; label = @4
              local.get 4
              i32.const 12
              i32.add
              i32.load
              local.tee 5
              i32.eqz
              br_if 0 (;@4;)
              local.get 4
              i32.const 8
              i32.add
              i32.load
              local.get 5
              call 12
            end
            local.get 4
            i32.const 20
            i32.add
            local.set 4
            local.get 2
            i32.const -1
            i32.add
            local.tee 2
            br_if 0 (;@3;)
          end
          local.get 1
          i32.const 20
          i32.mul
          local.tee 4
          i32.eqz
          br_if 0 (;@2;)
          local.get 3
          local.get 4
          call 12
        end
        local.get 0
        i32.load offset=16
        local.tee 3
        i32.eqz
        br_if 0 (;@1;)
        local.get 0
        i32.load offset=12
        local.set 1
        i32.const 0
        local.set 2
        local.get 3
        local.set 5
        loop ;; label = @2
          block ;; label = @3
            local.get 1
            local.get 2
            i32.add
            local.tee 4
            i32.const 4
            i32.add
            i32.load
            local.tee 0
            i32.eqz
            br_if 0 (;@3;)
            local.get 4
            i32.load
            local.get 0
            call 12
          end
          block ;; label = @3
            local.get 4
            i32.const 12
            i32.add
            i32.load
            local.tee 0
            i32.eqz
            br_if 0 (;@3;)
            local.get 4
            i32.const 8
            i32.add
            i32.load
            local.get 0
            call 12
          end
          block ;; label = @3
            local.get 4
            i32.const 20
            i32.add
            i32.load
            local.tee 0
            i32.eqz
            br_if 0 (;@3;)
            local.get 4
            i32.const 16
            i32.add
            i32.load
            local.get 0
            call 12
          end
          block ;; label = @3
            local.get 4
            i32.const 28
            i32.add
            i32.load8_u
            i32.eqz
            br_if 0 (;@3;)
            local.get 4
            i32.const 36
            i32.add
            i32.load
            local.tee 0
            i32.eqz
            br_if 0 (;@3;)
            local.get 4
            i32.const 32
            i32.add
            i32.load
            local.get 0
            call 12
          end
          local.get 2
          i32.const 40
          i32.add
          local.set 2
          local.get 5
          i32.const -1
          i32.add
          local.tee 5
          br_if 0 (;@2;)
        end
        local.get 3
        i32.const 40
        i32.mul
        local.tee 4
        i32.eqz
        br_if 0 (;@1;)
        local.get 1
        local.get 4
        call 12
      end
    )
    (func (;15;) (type 1) (param i32)
      (local i32)
      block ;; label = @1
        local.get 0
        i32.load8_u
        br_if 0 (;@1;)
        local.get 0
        i32.load offset=12
        local.tee 1
        i32.eqz
        br_if 0 (;@1;)
        local.get 0
        i32.load offset=8
        local.get 1
        call 12
      end
    )
    (func (;16;) (type 1) (param i32)
      (local i32)
      block ;; label = @1
        local.get 0
        i32.load8_u
        br_if 0 (;@1;)
        local.get 0
        i32.load offset=8
        local.tee 1
        i32.eqz
        br_if 0 (;@1;)
        local.get 0
        i32.load offset=4
        local.get 1
        call 12
      end
    )
    (func (;17;) (type 7) (param i32 i32 i32 i64 i32 i32 i32 i64 i32) (result i32)
      (local i32 i32 i32)
      global.get 0
      i32.const 16
      i32.sub
      local.tee 9
      global.set 0
      block ;; label = @1
        global.get 1
        i32.const 43122692
        i32.add
        i32.load8_u
        br_if 0 (;@1;)
        global.get 1
        local.set 10
        call 0
        local.get 10
        i32.const 43122692
        i32.add
        i32.const 1
        i32.store8
      end
      block ;; label = @1
        block ;; label = @2
          block ;; label = @3
            block ;; label = @4
              block ;; label = @5
                block ;; label = @6
                  block ;; label = @7
                    block ;; label = @8
                      local.get 0
                      br_table 0 (;@8;) 4 (;@4;) 7 (;@1;) 7 (;@1;) 1 (;@7;)
                    end
                    local.get 7
                    i32.wrap_i64
                    local.set 11
                    i32.const -2147483644
                    local.set 0
                    block ;; label = @8
                      block ;; label = @9
                        block ;; label = @10
                          block ;; label = @11
                            block ;; label = @12
                              local.get 6
                              br_table 0 (;@12;) 1 (;@11;) 2 (;@10;) 3 (;@9;) 4 (;@8;)
                            end
                            local.get 9
                            local.get 8
                            i32.store offset=12
                            local.get 9
                            local.get 11
                            i32.store offset=8
                            local.get 8
                            i32.const 8
                            i32.shr_u
                            local.set 10
                            local.get 9
                            i64.load offset=8
                            local.set 7
                            i32.const -2147483648
                            local.set 0
                            br 3 (;@8;)
                          end
                          i32.const -2147483647
                          local.set 0
                          br 2 (;@8;)
                        end
                        local.get 7
                        i64.const 255
                        i64.and
                        i64.const 0
                        i64.ne
                        local.set 8
                        i32.const -2147483646
                        local.set 0
                        br 1 (;@8;)
                      end
                      local.get 11
                      i32.const 8
                      i32.shr_u
                      local.set 10
                      local.get 8
                      i64.extend_i32_u
                      local.set 7
                      local.get 8
                      local.set 0
                      local.get 11
                      local.set 8
                    end
                    local.get 9
                    local.get 8
                    i32.store8 offset=4
                    local.get 9
                    local.get 7
                    i64.store offset=8
                    local.get 9
                    local.get 10
                    i32.store16 offset=5 align=1
                    local.get 9
                    local.get 10
                    i32.const 16
                    i32.shr_u
                    i32.store8 offset=7
                    local.get 5
                    i32.const -1
                    i32.gt_s
                    br_if 2 (;@5;)
                    local.get 0
                    i32.const 8
                    i32.shr_u
                    local.set 8
                    local.get 5
                    i32.const -2147483648
                    i32.add
                    br_table 4 (;@3;) 6 (;@1;) 6 (;@1;) 1 (;@6;)
                  end
                  local.get 9
                  local.get 1
                  i32.store offset=4
                  local.get 9
                  local.get 2
                  i32.store offset=8
                  local.get 2
                  i32.const 8
                  i32.shr_u
                  local.set 8
                  local.get 2
                  local.set 0
                end
                local.get 8
                i32.const 8
                i32.shl
                local.get 0
                i32.const 255
                i32.and
                i32.or
                local.tee 0
                i32.eqz
                br_if 4 (;@1;)
                local.get 9
                i32.const 4
                i32.add
                local.set 2
                br 3 (;@2;)
              end
              block ;; label = @5
                local.get 2
                i32.eqz
                br_if 0 (;@5;)
                local.get 1
                local.get 2
                call 12
              end
              block ;; label = @5
                local.get 5
                i32.eqz
                br_if 0 (;@5;)
                local.get 4
                local.get 5
                call 12
              end
              block ;; label = @5
                block ;; label = @6
                  local.get 0
                  i32.const -2147483648
                  i32.xor
                  i32.const 3
                  local.get 0
                  i32.const 0
                  i32.lt_s
                  select
                  br_table 0 (;@6;) 5 (;@1;) 5 (;@1;) 1 (;@5;) 5 (;@1;)
                end
                local.get 9
                i32.load offset=4
                local.tee 0
                i32.eqz
                br_if 4 (;@1;)
                local.get 9
                i32.const 8
                i32.add
                local.set 2
                br 3 (;@2;)
              end
              local.get 0
              i32.eqz
              br_if 3 (;@1;)
              local.get 9
              i32.const 4
              i32.add
              local.set 2
              br 2 (;@2;)
            end
            local.get 9
            local.get 1
            i32.store offset=4
            local.get 9
            local.get 2
            i32.store offset=8
            local.get 2
            i32.const 8
            i32.shr_u
            local.set 8
            local.get 2
            local.set 0
          end
          local.get 8
          i32.const 8
          i32.shl
          local.get 0
          i32.const 255
          i32.and
          i32.or
          local.tee 0
          i32.eqz
          br_if 1 (;@1;)
          local.get 9
          i32.const 4
          i32.add
          local.set 2
        end
        local.get 2
        i32.load
        local.get 0
        call 12
      end
      global.get 1
      i32.const 1114112
      i32.add
      local.tee 0
      i32.const 256
      i32.store16
      local.get 9
      i32.const 16
      i32.add
      global.set 0
      local.get 0
    )
    (func (;18;) (type 8) (param i32) (result i32)
      (local i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i64 i64 i64 i32)
      global.get 0
      i32.const 32
      i32.sub
      local.tee 1
      global.set 0
      block ;; label = @1
        global.get 1
        i32.const 43122692
        i32.add
        i32.load8_u
        br_if 0 (;@1;)
        global.get 1
        local.set 2
        call 0
        local.get 2
        i32.const 43122692
        i32.add
        i32.const 1
        i32.store8
      end
      block ;; label = @1
        block ;; label = @2
          local.get 0
          i32.load offset=48
          local.tee 3
          i32.const -1
          i32.le_s
          br_if 0 (;@2;)
          block ;; label = @3
            local.get 3
            i32.eqz
            br_if 0 (;@3;)
            local.get 0
            i32.load offset=44
            local.set 4
            i32.const 1
            local.get 3
            call 10
            local.tee 5
            i32.eqz
            br_if 2 (;@1;)
            i32.const 0
            local.set 2
            local.get 1
            i32.const 0
            i32.store offset=16
            local.get 1
            local.get 5
            i32.store offset=12
            local.get 1
            local.get 3
            i32.store offset=8
            loop ;; label = @4
              local.get 4
              local.get 2
              i32.add
              i32.load8_u
              local.set 6
              block ;; label = @5
                local.get 2
                local.get 1
                i32.load offset=8
                i32.ne
                br_if 0 (;@5;)
                local.get 1
                i32.const 8
                i32.add
                call 6
                local.get 1
                i32.load offset=12
                local.set 5
              end
              local.get 5
              local.get 2
              i32.add
              local.get 6
              i32.store8
              local.get 1
              local.get 2
              i32.const 1
              i32.add
              local.tee 6
              i32.store offset=16
              local.get 6
              local.set 2
              local.get 3
              local.get 6
              i32.ne
              br_if 0 (;@4;)
            end
            local.get 4
            local.get 3
            call 12
          end
          local.get 0
          i32.load offset=140
          local.tee 7
          i32.const 38347923
          i32.ge_u
          br_if 0 (;@2;)
          local.get 0
          i32.load offset=136
          local.set 8
          i32.const 8
          local.set 9
          i32.const 0
          local.set 2
          block ;; label = @3
            local.get 7
            i32.const 56
            i32.mul
            local.tee 6
            i32.eqz
            br_if 0 (;@3;)
            local.get 7
            local.set 2
            i32.const 8
            local.get 6
            call 10
            local.tee 9
            i32.eqz
            br_if 2 (;@1;)
          end
          local.get 1
          i32.const 0
          i32.store offset=28
          local.get 1
          local.get 9
          i32.store offset=24
          local.get 1
          local.get 2
          i32.store offset=20
          block ;; label = @3
            local.get 7
            i32.eqz
            br_if 0 (;@3;)
            i32.const 0
            local.set 5
            i32.const 0
            local.set 3
            i32.const 0
            local.set 6
            loop ;; label = @4
              local.get 8
              local.get 3
              i32.add
              local.tee 2
              i32.const 16
              i32.add
              i32.load8_u
              i32.const 0
              i32.ne
              local.set 10
              local.get 2
              i32.load
              local.set 11
              local.get 2
              i32.const 40
              i32.add
              i64.load
              local.set 12
              local.get 2
              i32.const 32
              i32.add
              i64.load
              local.set 13
              local.get 2
              i32.const 24
              i32.add
              i64.load
              local.set 14
              local.get 2
              i32.const 12
              i32.add
              i32.load
              local.set 4
              local.get 2
              i32.const 8
              i32.add
              i32.load
              local.set 15
              local.get 2
              i32.const 4
              i32.add
              i32.load
              local.set 0
              block ;; label = @5
                local.get 6
                local.get 1
                i32.load offset=20
                i32.ne
                br_if 0 (;@5;)
                local.get 1
                i32.const 20
                i32.add
                call 7
                local.get 1
                i32.load offset=24
                local.set 9
              end
              local.get 9
              local.get 5
              i32.add
              local.tee 2
              local.get 14
              i64.store
              local.get 2
              i32.const 48
              i32.add
              local.get 10
              i32.store8
              local.get 2
              i32.const 44
              i32.add
              local.get 4
              i32.store
              local.get 2
              i32.const 40
              i32.add
              local.get 15
              i32.store
              local.get 2
              i32.const 36
              i32.add
              local.get 4
              i32.store
              local.get 2
              i32.const 32
              i32.add
              local.get 0
              i32.store
              local.get 2
              i32.const 28
              i32.add
              local.get 11
              i32.store
              local.get 2
              i32.const 24
              i32.add
              local.get 0
              i32.store
              local.get 2
              i32.const 16
              i32.add
              local.get 12
              i64.store
              local.get 2
              i32.const 8
              i32.add
              local.get 13
              i64.store
              local.get 1
              local.get 6
              i32.const 1
              i32.add
              local.tee 6
              i32.store offset=28
              local.get 5
              i32.const 56
              i32.add
              local.set 5
              local.get 3
              i32.const 48
              i32.add
              local.set 3
              local.get 7
              local.get 6
              i32.ne
              br_if 0 (;@4;)
            end
            local.get 8
            local.get 7
            i32.const 48
            i32.mul
            call 12
          end
          call 1
          unreachable
        end
        call 19
        unreachable
      end
      call 13
      unreachable
    )
    (func (;19;) (type 0)
      call 13
      unreachable
    )
    (func (;20;) (type 5) (param i32 i32 i32 i32) (result i32)
      (local i32 i32)
      global.get 0
      i32.const 32
      i32.sub
      local.tee 4
      global.set 0
      block ;; label = @1
        global.get 1
        i32.const 43122692
        i32.add
        i32.load8_u
        br_if 0 (;@1;)
        global.get 1
        local.set 5
        call 0
        local.get 5
        i32.const 43122692
        i32.add
        i32.const 1
        i32.store8
      end
      block ;; label = @1
        local.get 1
        i32.eqz
        br_if 0 (;@1;)
        local.get 0
        local.get 1
        call 12
      end
      block ;; label = @1
        block ;; label = @2
          local.get 3
          i32.const -1
          i32.ne
          br_if 0 (;@2;)
          global.get 1
          i32.const 1114112
          i32.add
          local.tee 3
          local.get 2
          i32.store8 offset=4
          local.get 3
          i32.const 1
          i32.store8
          br 1 (;@1;)
        end
        global.get 1
        i32.const 1114112
        i32.add
        local.tee 1
        i32.const 2
        i32.store offset=4
        local.get 1
        i32.const 0
        i32.store8
        local.get 4
        local.get 3
        i32.store offset=28
        local.get 4
        local.get 2
        i32.store offset=24
        local.get 4
        local.get 3
        i32.store offset=20
        local.get 4
        i32.const 8
        i32.add
        local.get 4
        i32.const 20
        i32.add
        call 11
        local.get 1
        local.get 4
        i64.load offset=8
        i64.store offset=8 align=4
      end
      global.get 1
      local.set 3
      local.get 4
      i32.const 32
      i32.add
      global.set 0
      local.get 3
      i32.const 1114112
      i32.add
    )
    (func (;21;) (type 9) (param i32 i32 i32 i32 i32 i32) (result i32)
      (local i32 i32 i32 i32 i32 i32 i32 i32)
      global.get 0
      i32.const 32
      i32.sub
      local.tee 6
      global.set 0
      block ;; label = @1
        global.get 1
        i32.const 43122692
        i32.add
        i32.load8_u
        br_if 0 (;@1;)
        global.get 1
        local.set 7
        call 0
        local.get 7
        i32.const 43122692
        i32.add
        i32.const 1
        i32.store8
      end
      block ;; label = @1
        block ;; label = @2
          local.get 5
          i32.const 178956971
          i32.ge_u
          br_if 0 (;@2;)
          block ;; label = @3
            block ;; label = @4
              local.get 5
              i32.const 12
              i32.mul
              local.tee 7
              br_if 0 (;@4;)
              i32.const 4
              local.set 8
              i32.const 0
              local.set 9
              br 1 (;@3;)
            end
            local.get 5
            local.set 9
            i32.const 4
            local.get 7
            call 10
            local.tee 8
            i32.eqz
            br_if 2 (;@1;)
          end
          local.get 6
          i32.const 0
          i32.store offset=28
          local.get 6
          local.get 8
          i32.store offset=24
          local.get 6
          local.get 9
          i32.store offset=20
          block ;; label = @3
            local.get 5
            i32.eqz
            br_if 0 (;@3;)
            i32.const 0
            local.set 7
            i32.const 8
            local.set 9
            local.get 4
            local.set 10
            loop ;; label = @4
              local.get 10
              i32.const 4
              i32.add
              i32.load
              local.set 11
              local.get 10
              i32.load
              local.set 12
              block ;; label = @5
                local.get 7
                local.get 6
                i32.load offset=20
                i32.ne
                br_if 0 (;@5;)
                local.get 6
                i32.const 20
                i32.add
                call 3
                local.get 6
                i32.load offset=24
                local.set 8
              end
              local.get 8
              local.get 9
              i32.add
              local.tee 13
              local.get 11
              i32.store
              local.get 13
              i32.const -4
              i32.add
              local.get 12
              i32.store
              local.get 13
              i32.const -8
              i32.add
              local.get 11
              i32.store
              local.get 6
              local.get 7
              i32.const 1
              i32.add
              local.tee 7
              i32.store offset=28
              local.get 9
              i32.const 12
              i32.add
              local.set 9
              local.get 10
              i32.const 8
              i32.add
              local.set 10
              local.get 5
              local.get 7
              i32.ne
              br_if 0 (;@4;)
            end
            local.get 4
            local.get 5
            i32.const 3
            i32.shl
            call 12
            local.get 6
            i32.load offset=24
            local.set 8
            local.get 6
            i32.load offset=20
            local.set 9
          end
          i32.const 1
          i32.const 3
          call 10
          local.tee 11
          i32.eqz
          br_if 1 (;@1;)
          local.get 11
          global.get 1
          i32.const 1048576
          i32.add
          local.tee 7
          i32.load8_u offset=2
          i32.store8 offset=2
          local.get 11
          local.get 7
          i32.load16_u align=1
          i32.store16 align=1
          block ;; label = @3
            local.get 1
            i32.eqz
            br_if 0 (;@3;)
            local.get 0
            local.get 1
            call 12
          end
          block ;; label = @3
            local.get 3
            i32.eqz
            br_if 0 (;@3;)
            local.get 2
            local.get 3
            call 12
          end
          block ;; label = @3
            local.get 5
            i32.eqz
            br_if 0 (;@3;)
            local.get 8
            local.set 7
            loop ;; label = @4
              block ;; label = @5
                local.get 7
                i32.load
                local.tee 10
                i32.eqz
                br_if 0 (;@5;)
                local.get 7
                i32.const 4
                i32.add
                i32.load
                local.get 10
                call 12
              end
              local.get 7
              i32.const 12
              i32.add
              local.set 7
              local.get 5
              i32.const -1
              i32.add
              local.tee 5
              br_if 0 (;@4;)
            end
          end
          block ;; label = @3
            local.get 9
            i32.eqz
            br_if 0 (;@3;)
            local.get 8
            local.get 9
            i32.const 12
            i32.mul
            call 12
          end
          global.get 1
          i32.const 1114112
          i32.add
          local.tee 7
          i32.const 0
          i32.store8
          local.get 6
          i32.const 3
          i32.store offset=28
          local.get 6
          local.get 11
          i32.store offset=24
          local.get 6
          i32.const 3
          i32.store offset=20
          local.get 6
          i32.const 8
          i32.add
          local.get 6
          i32.const 20
          i32.add
          call 11
          local.get 7
          local.get 6
          i64.load offset=8
          i64.store offset=4 align=4
          local.get 6
          i32.const 32
          i32.add
          global.set 0
          local.get 7
          return
        end
        call 19
        unreachable
      end
      call 13
      unreachable
    )
    (func (;22;) (type 0)
      (local i32)
      block ;; label = @1
        global.get 1
        i32.const 43122692
        i32.add
        i32.load8_u
        br_if 0 (;@1;)
        global.get 1
        local.set 0
        call 0
        local.get 0
        i32.const 43122692
        i32.add
        i32.const 1
        i32.store8
      end
    )
    (func (;23;) (type 5) (param i32 i32 i32 i32) (result i32)
      (local i32 i32)
      i32.const 0
      local.set 4
      block ;; label = @1
        local.get 2
        i32.const 1
        local.get 2
        i32.const 1
        i32.gt_u
        select
        local.tee 2
        local.get 2
        i32.const -1
        i32.add
        i32.and
        br_if 0 (;@1;)
        local.get 3
        i32.const -2147483648
        local.get 2
        i32.sub
        local.tee 5
        i32.gt_u
        br_if 0 (;@1;)
        local.get 2
        local.get 3
        call 10
        local.tee 2
        i32.eqz
        br_if 0 (;@1;)
        block ;; label = @2
          local.get 0
          i32.eqz
          br_if 0 (;@2;)
          local.get 1
          i32.eqz
          br_if 0 (;@2;)
          block ;; label = @3
            local.get 3
            local.get 1
            local.get 3
            local.get 1
            i32.lt_u
            select
            local.tee 3
            i32.eqz
            br_if 0 (;@3;)
            local.get 2
            local.get 0
            local.get 3
            memory.copy
          end
          local.get 1
          local.get 5
          i32.gt_u
          br_if 0 (;@2;)
          local.get 0
          local.get 1
          call 12
        end
        local.get 2
        local.set 4
      end
      local.get 4
    )
    (func (;24;) (type 10) (param i32 i32 i32) (result i32)
      (local i32 i32)
      loop ;; label = @1
        block ;; label = @2
          local.get 2
          br_if 0 (;@2;)
          i32.const 0
          return
        end
        local.get 2
        i32.const -1
        i32.add
        local.set 2
        local.get 1
        i32.load8_u
        local.set 3
        local.get 0
        i32.load8_u
        local.set 4
        local.get 1
        i32.const 1
        i32.add
        local.set 1
        local.get 0
        i32.const 1
        i32.add
        local.set 0
        local.get 4
        local.get 3
        i32.eq
        br_if 0 (;@1;)
      end
      local.get 4
      local.get 3
      i32.sub
    )
    (data (;0;) (i32.const 1048576) "G45")
    (data (;1;) (i32.const 1048580) "\01\00\00\00\01\00\00\00")
    (@producers
      (processed-by "wit-component" "0.235.0")
      (processed-by "wit-bindgen-rust" "0.43.0")
    )
  )
  (core instance $main (;0;) (instantiate $main))
  (alias core export $main "memory" (core memory $memory (;0;)))
  (type (;17;) (result $"#type16 plugin-model" (error $"#type6 contract-error")))
  (type (;18;) (func (param "context" $"#type10 host-context") (result 17)))
  (alias core export $main "initialize" (core func $initialize (;0;)))
  (alias core export $main "cabi_realloc" (core func $cabi_realloc (;1;)))
  (alias core export $main "cabi_post_initialize" (core func $cabi_post_initialize (;2;)))
  (func $initialize (;0;) (type 18) (canon lift (core func $initialize) (memory $memory) (realloc $cabi_realloc) string-encoding=utf8 (post-return $cabi_post_initialize)))
  (export $"#func1 initialize" (@name "initialize") (;1;) "initialize" (func $initialize))
  (type (;19;) (result $"#type8 event-result" (error $"#type6 contract-error")))
  (type (;20;) (func (param "event" $"#type14 plugin-event") (result 19)))
  (alias core export $main "handle-event" (core func $handle-event (;3;)))
  (func $handle-event (;2;) (type 20) (canon lift (core func $handle-event) (memory $memory) (realloc $cabi_realloc) string-encoding=utf8))
  (export $"#func3 handle-event" (@name "handle-event") (;3;) "handle-event" (func $handle-event))
  (type (;21;) (result $"#type4 command-result" (error $"#type6 contract-error")))
  (type (;22;) (func (param "invocation" $"#type2 command-invocation") (result 21)))
  (alias core export $main "run-command" (core func $run-command (;4;)))
  (alias core export $main "cabi_post_run-command" (core func $cabi_post_run-command (;5;)))
  (func $run-command (;4;) (type 22) (canon lift (core func $run-command) (memory $memory) (realloc $cabi_realloc) string-encoding=utf8 (post-return $cabi_post_run-command)))
  (export $"#func5 run-command" (@name "run-command") (;5;) "run-command" (func $run-command))
  (type (;23;) (list u8))
  (type (;24;) (result $"#type12 migrated-state" (error $"#type6 contract-error")))
  (type (;25;) (func (param "previous-api" string) (param "state" 23) (result 24)))
  (alias core export $main "migrate-state" (core func $migrate-state (;6;)))
  (alias core export $main "cabi_post_migrate-state" (core func $cabi_post_migrate-state (;7;)))
  (func $migrate-state (;6;) (type 25) (canon lift (core func $migrate-state) (memory $memory) (realloc $cabi_realloc) string-encoding=utf8 (post-return $cabi_post_migrate-state)))
  (export $"#func7 migrate-state" (@name "migrate-state") (;7;) "migrate-state" (func $migrate-state))
  (type (;26;) (func))
  (alias core export $main "shutdown" (core func $shutdown (;8;)))
  (func $shutdown (;8;) (type 26) (canon lift (core func $shutdown)))
  (export $"#func9 shutdown" (@name "shutdown") (;9;) "shutdown" (func $shutdown))
  (@producers
    (processed-by "wit-component" "0.246.2")
  )
)
