// A fast drop-in for csv-reader 1.0.0: run(input) answers {columns, rows, errors}
// exactly as the reference does, for every {text, header}.
//
// The reference reads one character at a time; this reader slices whole
// fields at once. It keeps, for the text, the positions of the next comma,
// line feed and carriage return at or after the point it has read to. The
// reading position only moves forward, so a cached position at or after it
// is still the next one, and each of the three searches covers the text
// once in total. A plain field is one slice up to the nearest of those
// three; a quoted field is found with indexOf('"'), doubled quotes joined
// in, and carriage returns inside it turned into line feeds. Nothing here
// reads the clock, randomness or the environment, so the answer is a pure
// function of the input.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const BREAK = 1;
const END = 2;

const CHAR_COMMA = 44; // ,
const CHAR_QUOTE = 34; // "
const CHAR_LF = 10; // \n
const CHAR_CR = 13; // \r
const CHAR_BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === CHAR_BOM) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Cached positions of the next ',', '\n' and '\r' at or after the point
  // they were searched from: -2 not searched yet, -1 none left in the text.
  let nextComma = -2;
  let nextLF = -2;
  let nextCR = -2;

  // How the field just read ended, and how many characters a junk tail kept.
  let ended = END;
  let added = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The next comma at or after pos, or -1 when there is none.
  function atComma() {
    if (nextComma === -2 || (nextComma !== -1 && nextComma < pos)) nextComma = text.indexOf(',', pos);
    return nextComma;
  }

  // The next line feed at or after pos, or -1 when there is none.
  function atLF() {
    if (nextLF === -2 || (nextLF !== -1 && nextLF < pos)) nextLF = text.indexOf('\n', pos);
    return nextLF;
  }

  // The next carriage return at or after pos, or -1 when there is none.
  function atCR() {
    if (nextCR === -2 || (nextCR !== -1 && nextCR < pos)) nextCR = text.indexOf('\r', pos);
    return nextCR;
  }

  // How many line feeds s holds.
  function countLF(s) {
    let count = 0;
    let i = s.indexOf('\n');
    while (i !== -1) {
      count += 1;
      i = s.indexOf('\n', i + 1);
    }
    return count;
  }

  // Every carriage return and CRLF in s turned into one line feed.
  function normalizeCR(s) {
    let out = '';
    let start = 0;
    for (;;) {
      const r = s.indexOf('\r', start);
      if (r === -1) break;
      out += s.slice(start, r);
      out += '\n';
      start = s.charCodeAt(r + 1) === CHAR_LF ? r + 2 : r + 1;
    }
    return out + s.slice(start);
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Sets `ended`
  // and `added` (the characters kept onto value) and returns the field.
  function readUnquoted(value) {
    added = 0;
    let start = pos;
    for (;;) {
      const c = atComma();
      const n = atLF();
      const r = atCR();
      let end;
      let kind;
      if (c !== -1 && (n === -1 || c < n)) {
        end = c;
        kind = COMMA;
      } else if (n !== -1) {
        end = n;
        kind = BREAK;
      } else {
        end = len;
        kind = END;
      }
      if (r !== -1 && r < end) {
        if (text.charCodeAt(r + 1) === CHAR_LF) {
          // A CRLF ends the field here.
          value += text.slice(start, r);
          added += r - start;
          pos = r + 2;
          line += 1;
          ended = BREAK;
          return value;
        }
        // A lone CR is dropped and the field goes on past it.
        error('stray_cr');
        value += text.slice(start, r);
        added += r - start;
        pos = r + 1;
        start = pos;
        continue;
      }
      value += text.slice(start, end);
      added += end - start;
      if (kind === COMMA) {
        pos = end + 1;
        ended = COMMA;
      } else if (kind === BREAK) {
        pos = end + 1;
        line += 1;
        ended = BREAK;
      } else {
        pos = end;
        ended = END;
      }
      return value;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;
    let search = start;
    let segStart = start;
    let parts = null; // the value's ranges, split at each doubled quote
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', search);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted, from the line it opened on.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === CHAR_QUOTE) {
        if (parts === null) parts = [];
        parts.push(segStart, q);
        segStart = q + 2;
        search = q + 2;
        continue;
      }
      close = q;
      break;
    }
    let value;
    if (parts === null) {
      value = text.slice(start, close);
    } else {
      parts.push(segStart, close);
      const chunks = [];
      for (let i = 0; i < parts.length; i += 2) {
        if (i > 0) chunks.push('"');
        chunks.push(text.slice(parts[i], parts[i + 1]));
      }
      value = chunks.join('');
    }
    // Each CRLF or lone CR inside quotes is one LF, and each counts as a
    // line — so the line feeds in the value are exactly the lines it spans.
    if (value.indexOf('\r') !== -1) value = normalizeCR(value);
    line += countLF(value);
    pos = close + 1;
    if (pos >= len) {
      ended = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === CHAR_COMMA) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (c === CHAR_LF) {
      pos += 1;
      line += 1;
      ended = BREAK;
      return value;
    }
    if (c === CHAR_CR && text.charCodeAt(pos + 1) === CHAR_LF) {
      pos += 2;
      line += 1;
      ended = BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    value = readUnquoted(value);
    if (added > 0) error('quote_junk');
    return value;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === CHAR_LF) {
        pos += 1;
        line += 1;
      } else if (c === CHAR_CR && text.charCodeAt(pos + 1) === CHAR_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === CHAR_QUOTE;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
