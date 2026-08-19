# Third-party references

This implementation was written for BBCOM from the public protocol
specifications. Its command inventory, error mapping, and expected behavior
were compared with **mcumgr-toolkit 0.16.0**, Git tag commit
`71ab71919883d2bac7da5c7935ca5034bd71ca2c`, by Finomnis. That project is
available under `MIT OR Apache-2.0` at:

<https://github.com/Finomnis/mcumgr-toolkit>

The wire format and command identifiers follow the Zephyr Project MCUmgr/SMP
specifications and headers, which are available under Apache-2.0:

- <https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html>
- <https://docs.zephyrproject.org/latest/services/device_mgmt/smp_transport.html>
- <https://docs.zephyrproject.org/latest/services/device_mgmt/mcumgr.html>

No source from `mcumgr-toolkit` is linked into this workspace. In particular,
the component does not use its native `serialport` / `std::io` transport. All
serial and file I/O is supplied by opaque BBCOM v2 lease/grant resources, and
the built component import audit rejects WASI and ambient native authority.
