(component
  (type $field-kind (enum "text" "number" "toggle" "select" "button"))
  (type $panel-field (record
    (field "id" string) (field "label" string) (field "kind" $field-kind)
    (field "value" string) (field "options" (list string))
    (field "disabled" bool)))
  (type $panel (record
    (field "title" string) (field "fields" (list $panel-field))))
  (type $panel-result (result $panel (error string)))
  (type $panel-event (record
    (field "field-id" string) (field "value" string)))
  (core module $guest
    (memory (export "memory") 2)
    (func (export "realloc") (param i32 i32 i32 i32) (result i32) i32.const 4096)
    (func (export "initialize") (result i32)
      i32.const 1024
      memory.grow
      drop
      i32.const 0)
    (func (export "handle-panel-event") (param i32 i32 i32 i32) (result i32) unreachable)
    (func (export "shutdown")))
  (core instance $instance (instantiate $guest))
  (alias core export $instance "memory" (core memory $memory))
  (core func $realloc (alias core export $instance "realloc"))
  (core func $initialize (alias core export $instance "initialize"))
  (core func $handle-panel-event (alias core export $instance "handle-panel-event"))
  (core func $shutdown (alias core export $instance "shutdown"))
  (func (export "initialize") (result $panel-result)
    (canon lift (core func $initialize)
      string-encoding=utf8 (memory $memory) (realloc $realloc)))
  (func (export "handle-panel-event")
    (param "event" $panel-event) (result $panel-result)
    (canon lift (core func $handle-panel-event)
      string-encoding=utf8 (memory $memory) (realloc $realloc)))
  (func (export "shutdown") (canon lift (core func $shutdown))))
