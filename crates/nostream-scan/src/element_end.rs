/// The element size at which an incomplete element is first handed to the parser anyway.
///
/// Public because the reader that calls [`ElementEnd::probe_due`] documents its bound in terms
/// of it, and the proofs assert against it.
pub const FIRST_PROBE: usize = 64 * 1024;

/// Finds where one array element ends, carrying its state across reads, so a growing buffer is
/// scanned once in total and the element is parsed once its last byte has arrived.
///
/// It tracks only what can hide an element's end: string contents (with escapes) and bracket
/// depth. It does not judge the element's grammar; that is the parser's job. A scan can end too
/// early, which only means the parser sees and names the fault sooner. It can also end too
/// late, or never: a malformed element whose brackets do not balance looks unfinished until the
/// end of input. So the reader also parses an unfinished element each time it has doubled
/// since the last try (from [`FIRST_PROBE`]). That bounds what a malformed element buffers to
/// about twice the offset of its fault, and keeps the parsing linear: the tries sum to less
/// than twice the element.
#[derive(Debug)]
pub struct ElementEnd {
    /// Bytes of the element already scanned, counted from its first byte.
    scanned: usize,
    depth: usize,
    in_string: bool,
    escaped: bool,
    /// The element is a number or a literal, which ends at the first byte that cannot be in one.
    scalar: bool,
    /// The element's end has been found.
    found: bool,
    /// The element size at which an unfinished element is next handed to the parser.
    next_probe: usize,
}

impl Default for ElementEnd {
    fn default() -> Self {
        Self {
            scanned: 0,
            depth: 0,
            in_string: false,
            escaped: false,
            scalar: false,
            found: false,
            next_probe: FIRST_PROBE,
        }
    }
}

impl ElementEnd {
    /// Scans the bytes of `element` not seen before, and reports whether the element's end is
    /// among the bytes seen so far. `element` starts at the element's first byte.
    pub fn reached(&mut self, element: &[u8]) -> bool {
        while !self.found {
            let Some(&byte) = element.get(self.scanned) else {
                break;
            };

            if self.scanned == 0 {
                // The first byte decides the element's kind.
                match byte {
                    b'{' | b'[' => self.depth = 1,
                    b'"' => self.in_string = true,
                    _ => self.scalar = true,
                }
            } else if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.in_string = false;
                    self.found = self.depth == 0;
                }
            } else if !self.scalar {
                match byte {
                    b'"' => self.in_string = true,
                    b'{' | b'[' => self.depth += 1,
                    b'}' | b']' => {
                        // Saturating: a close with nothing open ends the element here, and
                        // the parser names it.
                        self.depth = self.depth.saturating_sub(1);
                        self.found = self.depth == 0;
                    }
                    _ => {}
                }
            }

            // A scalar ends before the first byte that cannot be in it.
            if self.scalar && ends_scalar(byte) {
                self.found = true;
                break;
            }

            self.scanned += 1;
        }

        self.found
    }

    /// The parser wanted more bytes than the scan expected: keep scanning past this point.
    ///
    /// A balanced container or a closed string cannot end early, so in practice this is a
    /// scalar the parser read past its delimiter. `scanned` sits on that delimiter; step over
    /// it, or the next scan would stop on it again.
    pub fn resume(&mut self) {
        if !self.found {
            return;
        }

        self.found = false;

        if self.scalar {
            self.scanned += 1;
        }
    }

    /// Whether an unfinished element of `len` bytes is due a parse, the try that catches a
    /// malformed element the scan cannot see the end of. Each try doubles the next threshold.
    ///
    /// Scalars are probed too, at a higher price: a prefix of a number parses as a whole value,
    /// and the separator check then names the byte after it, so a number longer than
    /// [`FIRST_PROBE`] is refused rather than read forever. Without this probe a scalar made of
    /// bytes that cannot end one — `[` followed by megabytes of `x` — buffered to the end of
    /// input before the parser saw its first byte.
    pub fn probe_due(&mut self, len: usize) -> bool {
        if len < self.next_probe {
            return false;
        }

        self.next_probe = len.saturating_mul(2);

        true
    }

    // Read by the proofs in `proofs.rs` and by nothing else. Gated so a normal
    // build carries no accessor whose only purpose is to state a property
    // about private state.

    /// The number of element bytes consumed so far.
    #[cfg(kani)]
    pub(crate) fn scanned(&self) -> usize {
        self.scanned
    }

    /// The element size at which the next probe falls due.
    #[cfg(kani)]
    pub(crate) fn next_probe(&self) -> usize {
        self.next_probe
    }

    /// Whether the element is a number or a literal rather than a string or container.
    #[cfg(kani)]
    pub(crate) fn is_scalar(&self) -> bool {
        self.scalar
    }
}

/// A byte that cannot continue a number or a literal.
fn ends_scalar(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b',' | b']' | b'}' | b'[' | b'{' | b'"')
}
