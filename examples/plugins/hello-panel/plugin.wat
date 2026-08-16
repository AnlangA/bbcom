;; Example guest Component implementing the `bbcom:plugin/plugin@1.0.0` world
;; (wit/bbcom-plugin-v1/plugin.wit) as reviewed WAT text, following the same
;; conventions as tests/fixtures/plugins/malicious.
;;
;; The plugin publishes one declarative panel with a single toggle field
;; ("hello.beacon"). `initialize` first calls the `storage-set` host import to
;; persist a greeting — the only capability effect observable from outside the
;; host — and then returns the "beacon off" panel. `handle-panel-event` returns
;; the "on" panel when the event value is "on" and the "off" panel otherwise.
;;
;; Component-model notes:
;; - Types referenced by imported/exported functions must themselves be named
;;   imports/exports, so the shared types interface is imported first and its
;;   aliased types are reused for both the host import and the world exports
;;   (imported types are valid in export positions too). Width subtyping means
;;   only the used members of each interface need to be declared.
;; - `result<declarative-panel, string>` flattens to 5 values, above the
;;   MAX_FLAT_RESULTS limit of 1, so both exports return a single i32 pointing
;;   at a guest-allocated return area (tag + max-case payload).
;; - `panel-event` flattens to 4 i32s, below MAX_FLAT_PARAMS, so its fields
;;   arrive as plain (ptr, len) pairs.
;; - The `storage-set` import needs the guest memory/realloc for lowered
;;   string/list parameters and its indirect result, so memory and realloc live
;;   in a shim module that the main module imports — this breaks the circular
;;   "lowered import needs guest memory" dependency.
(component
  (type $types-interface (instance
    (type $field-kind-literal (enum "text" "number" "toggle" "select" "button"))
    (export "field-kind" (type $field-kind (eq $field-kind-literal)))
    (type $panel-field-literal (record
      (field "id" string) (field "label" string) (field "kind" $field-kind)
      (field "value" string) (field "options" (list string))
      (field "disabled" bool)))
    (export "panel-field" (type $panel-field (eq $panel-field-literal)))
    (type $declarative-panel-literal (record
      (field "title" string) (field "fields" (list $panel-field))))
    (export "declarative-panel" (type $declarative-panel (eq $declarative-panel-literal)))
    (type $panel-event-literal (record
      (field "field-id" string) (field "value" string)))
    (export "panel-event" (type $panel-event (eq $panel-event-literal)))
    (type $contract-error-literal
      (enum "invalid-input" "limit-exceeded" "permission-denied" "unavailable"))
    (export "contract-error" (type $contract-error (eq $contract-error-literal)))))
  (import "bbcom:plugin/types@1.0.0" (instance $types (type $types-interface)))
  (alias export $types "declarative-panel" (type $declarative-panel-named))
  (alias export $types "panel-event" (type $panel-event-named))
  (alias export $types "contract-error" (type $contract-error-named))

  (type $storage-set-type
    (func (param "key" string) (param "value" (list u8))
          (result (result (error $contract-error-named)))))
  (type $host-interface
    (instance (export "storage-set" (func (type $storage-set-type)))))
  (import "bbcom:plugin/host@1.0.0" (instance $host (type $host-interface)))
  (alias export $host "storage-set" (func $host-storage-set))

  (type $panel-result (result $declarative-panel-named (error string)))

  ;; Shim: owns the linear memory and realloc used by canon lift/lower.
  ;; The host writes lowered-import results through realloc at 0x1000; all
  ;; static guest data lives at 0x100000 and above, so they never overlap.
  (core module $shim
    (memory (export "memory") 17)
    (func (export "realloc") (param i32 i32 i32 i32) (result i32)
      (i32.const 0x1000)))
  (core instance $shim-instance (instantiate $shim))
  (alias core export $shim-instance "memory" (core memory $memory))
  (core func $realloc (alias core export $shim-instance "realloc"))
  (core func $storage-set
    (canon lower (func $host-storage-set)
      string-encoding=utf8 (memory $memory) (realloc $realloc)))

  (core module $guest
    (import "env" "memory" (memory 1))
    (import "env" "realloc" (func $realloc (param i32 i32 i32 i32) (result i32)))
    ;; The lowered `storage-set` takes the indirect-result area as a trailing
    ;; parameter: (key-ptr, key-len, value-ptr, value-len, result-area-ptr).
    (import "env" "storage-set"
      (func $storage-set (param i32 i32 i32 i32 i32)))

    ;; Static strings. All reads are (pointer, length) pairs; no terminators.
    (data (i32.const 0x100000) "Hello Panel (beacon off)")
    (data (i32.const 0x100020) "Hello Panel (beacon on)")
    (data (i32.const 0x100040) "hello.beacon")
    (data (i32.const 0x100060) "Beacon")
    (data (i32.const 0x100080) "off")
    (data (i32.const 0x1000a0) "on")
    (data (i32.const 0x1000c0) "hello.greeting")
    (data (i32.const 0x1000e0) "Hello from the hello-panel plugin!")

    ;; Panel-field records (40 bytes each, alignment 4):
    ;;   id(ptr,len) label(ptr,len) kind value(ptr,len) options(ptr,len) disabled(u8)
    ;; field-kind 2 = toggle. Empty options list is (0, 0).
    (func $init
      (i32.store (i32.const 0x100200) (i32.const 0x100040))
      (i32.store (i32.const 0x100204) (i32.const 12))
      (i32.store (i32.const 0x100208) (i32.const 0x100060))
      (i32.store (i32.const 0x10020c) (i32.const 6))
      (i32.store (i32.const 0x100210) (i32.const 2))
      (i32.store (i32.const 0x100214) (i32.const 0x100080))
      (i32.store (i32.const 0x100218) (i32.const 3))
      (i32.store (i32.const 0x10021c) (i32.const 0))
      (i32.store (i32.const 0x100220) (i32.const 0))
      (i32.store8 (i32.const 0x100224) (i32.const 0))
      (i32.store (i32.const 0x100240) (i32.const 0x100040))
      (i32.store (i32.const 0x100244) (i32.const 12))
      (i32.store (i32.const 0x100248) (i32.const 0x100060))
      (i32.store (i32.const 0x10024c) (i32.const 6))
      (i32.store (i32.const 0x100250) (i32.const 2))
      (i32.store (i32.const 0x100254) (i32.const 0x1000a0))
      (i32.store (i32.const 0x100258) (i32.const 2))
      (i32.store (i32.const 0x10025c) (i32.const 0))
      (i32.store (i32.const 0x100260) (i32.const 0))
      (i32.store8 (i32.const 0x100264) (i32.const 0))
      ;; Result return areas (tag u32 + payload): ok/off, ok/on, error.
      (i32.store (i32.const 0x100280) (i32.const 0))
      (i32.store (i32.const 0x100284) (i32.const 0x100000))
      (i32.store (i32.const 0x100288) (i32.const 24))
      (i32.store (i32.const 0x10028c) (i32.const 0x100200))
      (i32.store (i32.const 0x100290) (i32.const 1))
      (i32.store (i32.const 0x1002a0) (i32.const 0))
      (i32.store (i32.const 0x1002a4) (i32.const 0x100020))
      (i32.store (i32.const 0x1002a8) (i32.const 23))
      (i32.store (i32.const 0x1002ac) (i32.const 0x100240))
      (i32.store (i32.const 0x1002b0) (i32.const 1))
      (i32.store (i32.const 0x1002c0) (i32.const 1))
      (i32.store (i32.const 0x1002c4) (i32.const 0x1000e0))
      (i32.store (i32.const 0x1002c8) (i32.const 34)))

    (func (export "initialize") (result i32)
      ;; storage-set("hello.greeting", "Hello from the hello-panel plugin!")
      ;; with 0x1002e0 as the indirect-result area.
      (call $storage-set
        (i32.const 0x1000c0) (i32.const 14)
        (i32.const 0x1000e0) (i32.const 34)
        (i32.const 0x1002e0))
      (if (i32.ne (i32.load (i32.const 0x1002e0)) (i32.const 0))
        (then (return (i32.const 0x1002c0))))
      (i32.const 0x100280))

    (func (export "handle-panel-event")
        (param $field-id-ptr i32) (param $field-id-len i32)
        (param $value-ptr i32) (param $value-len i32)
        (result i32)
      ;; "on" (second byte 'n' = 0x6e) switches the beacon on; anything else
      ;; (including "off") switches it off.
      (if (i32.and
            (i32.ge_u (local.get $value-len) (i32.const 2))
            (i32.eq
              (i32.load8_u (i32.add (local.get $value-ptr) (i32.const 1)))
              (i32.const 0x6e)))
        (then (return (i32.const 0x1002a0))))
      (i32.const 0x100280))

    (func (export "shutdown"))
    (start $init))
  (core instance $guest-instance (instantiate $guest
    (with "env" (instance
      (export "memory" (memory $memory))
      (export "realloc" (func $realloc))
      (export "storage-set" (func $storage-set))))))

  (core func $initialize (alias core export $guest-instance "initialize"))
  (core func $handle-panel-event
    (alias core export $guest-instance "handle-panel-event"))
  (core func $shutdown (alias core export $guest-instance "shutdown"))
  (func (export "initialize") (result $panel-result)
    (canon lift (core func $initialize)
      string-encoding=utf8 (memory $memory) (realloc $realloc)))
  (func (export "handle-panel-event")
    (param "event" $panel-event-named) (result $panel-result)
    (canon lift (core func $handle-panel-event)
      string-encoding=utf8 (memory $memory) (realloc $realloc)))
  (func (export "shutdown") (canon lift (core func $shutdown))))
