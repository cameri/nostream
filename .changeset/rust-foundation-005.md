---
---

fix(config): name the field whose number does not fit, not a valid neighbour

The loader's numeric walk read a field's type off the serialized defaults, where
`serialize_js_number` writes an integral `f64` as an integer because that is how
JavaScript represents it. So a valid `targetEventsPerSecond: 10.5` beside a
fractional `periodMs` was refused as "must be a whole number" while the actual
bad field went unreported. Every `f64` the schema declares is now restored to its
declared type before the walk runs, and a guard test keeps that list complete.
