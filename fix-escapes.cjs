const fs = require('fs');
let content = fs.readFileSync('src/web-cli.ts', 'utf8');

// Strategy:
// 1. The renderMarkdown function is inside a TS template literal (backtick string)
// 2. Backticks in the inline JS code close the template prematurely
// 3. We need to replace literal backticks with \x60 (hex escape for backtick)
// 4. Also fix backslash escaping: in TS template, \\n -> \n in output (correct for regex)
//    Currently we have 4 backslashes (\\\\) which produce \\ in output (wrong)
//    We need exactly 2 backslashes in the file

// Find function boundaries
const startMarker = '      function renderMarkdown(src) {';
const endMarker = '      }\n    })();';
const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker, startIdx);
if (startIdx === -1 || endIdx === -1) { console.log('Marker not found'); process.exit(1); }

let func = content.substring(startIdx, endIdx + endMarker.length);

// Step 1: Reduce 4+ backslashes to 2 (normalize backslash runs)
func = func.replace(/\\\\{4,}/g, '\\\\');

// Step 2: Replace literal backtick chars with \x60 escape
// In the TS template, \x60 -> backtick char in output (browser JS)
// This prevents backticks from closing the template prematurely
func = func.replace(/`/g, '\\x60');

// Step 3: Ensure \x00 (null byte placeholders) have single backslash
// \x00 in TS template -> null byte in output (correct)
// Nothing to do here, \x00 is correct

content = content.substring(0, startIdx) + func + content.substring(endIdx + endMarker.length);
fs.writeFileSync('src/web-cli.ts', content, 'utf8');
console.log('Fixed. Backticks replaced with \\x60, backslashes normalized.');
