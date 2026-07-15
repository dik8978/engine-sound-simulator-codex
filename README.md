# OSC Control

OSC control is available when the simulator is run locally with the Node server.
The GitHub Pages build is a static browser demo and cannot receive UDP OSC directly.

Default local OSC port:

```text
9000
```

Common OSC addresses:

```text
/engine/throttle       float 0-1, 0-100, or 0-127
/engine/brake          float 0-1, 0-100, or 0-127
/engine/accel          throttle alias
/engine/accelerator    throttle alias
/engine/gas            throttle alias
/throttle              throttle alias
/accel                 throttle alias
/accelerator           throttle alias
/gas                   throttle alias
/brake                 brake alias
/engine/pedals         throttle brake
/pedals                throttle brake
/engine/rpm            external RPM
/engine/load           external engine load
/engine/gear           gear number, 0 = neutral
/engine/gearup         shift up
/engine/geardown       shift down
/engine/ignition       0 or 1
/engine/mode           sim/ext or 0/1
/engine/config/<key>   runtime parameter update
```
