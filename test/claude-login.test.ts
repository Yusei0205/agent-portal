import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignInUrl, extractToken, safeSignInUrl, validAuthCode, stripAnsi } from '../server/claude-login.ts';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ST = ESC + String.fromCharCode(92); // ESC \ — the OSC string terminator
const CRLF = String.fromCharCode(13, 10);

describe('claude-login helpers', () => {
  it('reads the sign-in URL from the OSC 8 hyperlink', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz';
    const out = `Browser didn't open?${ESC}]8;id=u-1;${url}${ST}${ESC}[22;1Hhttps://claude.com/cai/oauth/auth${CRLF}orize...${ESC}]8;;${ST}`;
    assert.equal(extractSignInUrl(out), url);
  });
  it('rejects non-Claude or non-https URLs', () => {
    assert.equal(safeSignInUrl('https://evil.example/claude.com'), null);
    assert.equal(safeSignInUrl('http://claude.com/x'), null);
    assert.equal(safeSignInUrl('javascript:alert(1)'), null);
    assert.equal(extractSignInUrl(`${ESC}]8;;https://evil.example/x${ST}`), null);
  });
  it('extracts the long-lived token from styled output', () => {
    const tok = 'sk-ant-oat01-' + 'A1b2_-'.repeat(15);
    assert.equal(extractToken(`${ESC}[32mYour OAuth token (valid for 1 year):${ESC}[m${CRLF}${ESC}[1m${tok}${ESC}[m${CRLF}`), tok);
    assert.equal(extractToken('no token here'), null);
  });
  it('validates the pasted code and refuses control characters', () => {
    assert.equal(validAuthCode('abcDEF123_-~.%#xyz987654'), true);
    assert.equal(validAuthCode('short'), false);
    assert.equal(validAuthCode(`abcdefghij${CRLF}rm -rf /`), false);
    assert.equal(validAuthCode(`abcdefghij${ESC}[A`), false);
  });
  it('strips ANSI sequences', () => {
    assert.equal(stripAnsi(`${ESC}[31mred${ESC}[m ${ESC}]0;t${BEL}ok`), 'red ok');
  });
});
