// Transit Fabric claim page. Signs one text message with a browser wallet (signRaw, type "bytes").
// No transaction, no network request. The wallet libraries are the three pinned, SRI-checked scripts
// in claim.html (@polkadot/util 14.0.3, @polkadot/util-crypto 14.0.3, @polkadot/extension-dapp 0.64.1),
// served from this site (docs/vendor/polkadot).
//
// A tester without a browser wallet types the address instead, signs the same message with btcli and
// pastes the signature; the page checks it the same way.
//
// The message is v2: it carries the age attestation and the Terms/Privacy version the signer accepts
// (the same text as tools/lib/terms.mjs and the maintainers' checker). The page builds it only when
// the attestation box is ticked.
(function () {
  'use strict';
  if (window.top !== window.self) { document.body.textContent = 'This page must not be framed.'; return; }
  var $ = function (id) { return document.getElementById(id); };
  var U = window.polkadotUtil, C = window.polkadotUtilCrypto, D = window.polkadotExtensionDapp;
  var GH = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  var TERMS = '1';
  function attestation() { return 'I am 18 or older, or the age of majority where I live, whichever is higher, and I accept the Transit Fabric Terms of Service and Privacy Policy version ' + TERMS + '.'; }
  var state = { accounts: [], signature: null, ok: false };

  function say(text, cls) { var s = $('status'); s.textContent = text; s.className = cls || ''; }
  function today() { return new Date().toISOString().slice(0, 10); }
  var TMPL = 'btcli wallet sign --wallet-name <your wallet> --no-use-hotkey --message \'<message from step 4>\'';
  // A typed address (the btcli way) wins over the wallet account. '' when it is not a valid ss58 address of a 32-byte key.
  function typed() { return $('addr').value.trim(); }
  function validAddress(a) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(a) || !C) return false;
    try { return C.decodeAddress(a).length === 32; } catch (e) { return false; }
  }
  function address() { var t = typed(); return t ? (validAddress(t) ? t : '') : $('acct').value; }
  function message() {
    var gh = $('gh').value.trim(), addr = address();
    return 'Transit Fabric bounty v2: github=' + gh + ', address=' + addr + ', date=' + today() + ', age=18+, terms=' + TERMS + '. ' + attestation();
  }
  function refresh() {
    var gh = $('gh').value.trim(), t = typed(), addr = address(), ready = GH.test(gh) && !!addr, ok = ready && $('age').checked;
    state.ok = ok;
    $('msg').value = ok ? message() : (gh && !GH.test(gh) ? 'That is not a valid GitHub username.' : t && !addr ? (C ? 'That is not a valid address.' : 'The page libraries did not load, so the address cannot be checked. Reload the page.') : !ready ? 'Fill in your username, then connect a wallet or type your address.' : 'Confirm your age and the terms in step 3.');
    // The wallet signs only for its own account; a typed address is signed with btcli.
    $('sign').disabled = !ok || !!t;
    $('sig').disabled = !ok; $('sig').value = '';
    $('btcli').textContent = ok ? TMPL.split('<message from step 4>').join($('msg').value) : TMPL;
    clearClaim();
  }
  function clearClaim() {
    state.signature = null;
    $('claim').value = ''; $('check').textContent = ''; $('check').className = ''; $('copy').disabled = true; $('issue').hidden = true;
  }
  // Shows the claim block for a signature and, when it verifies, the copy button and the prefilled Issue link.
  function showClaim(msg, addr, sig, valid, bad) {
    state.signature = sig;
    $('claim').value = valid ? 'message: ' + msg + '\naddress: ' + addr + '\nsignature: ' + sig + '\n' : '';
    $('check').textContent = valid ? 'Checked in this page: the signature is valid for this message and address.' : bad;
    $('check').className = valid ? 'ok' : 'bad';
    $('copy').disabled = !valid;
    if (valid) {
      var q = new URLSearchParams({ template: 'registration.yml', title: 'Bounty registration', labels: 'bounty-registration', github: $('gh').value.trim(), address: addr, message: msg, signature: sig });
      var a = $('issue');
      a.href = 'https://github.com/transitfabric/releases/issues/new?' + q.toString();
      a.hidden = false;
    }
  }

  $('gh').addEventListener('input', refresh);
  $('acct').addEventListener('change', refresh);
  $('addr').addEventListener('input', refresh);
  $('age').addEventListener('change', refresh);
  $('termsv').textContent = TERMS;

  $('connect').addEventListener('click', async function () {
    if (!D || !U || !C) { say('The wallet libraries did not load. Check your connection, or use the btcli way below.', 'bad'); return; }
    say('Waiting for your wallet...');
    try {
      var exts = await D.web3Enable('Transit Fabric claim');
      if (!exts.length) { say('No wallet extension answered. Install one, unlock it, and allow this site.', 'bad'); return; }
      var all = await D.web3Accounts({ ss58Format: 42 });
      // The checker accepts sr25519 and ed25519. Skip ecdsa and ethereum accounts.
      state.accounts = all.filter(function (a) { return !a.type || a.type === 'sr25519' || a.type === 'ed25519'; });
      var sel = $('acct');
      sel.textContent = '';
      state.accounts.forEach(function (a) {
        var o = document.createElement('option');
        o.value = a.address;
        o.textContent = (a.meta && a.meta.name ? a.meta.name + ': ' : '') + a.address;
        sel.appendChild(o);
      });
      sel.disabled = !state.accounts.length;
      say(state.accounts.length ? 'Connected. Choose the account to register.' : 'The wallet has no sr25519 or ed25519 accounts.', state.accounts.length ? 'ok' : 'bad');
      refresh();
    } catch (e) { say('Could not connect: ' + (e && e.message || e), 'bad'); }
  });

  $('sign').addEventListener('click', async function () {
    if (!$('age').checked) { say('Confirm your age and the terms first.', 'bad'); return; }
    var addr = address(), msg = message();
    $('sign').disabled = true;
    say('Approve the signature request in your wallet. It shows plain text and no transaction.');
    try {
      var injector = await D.web3FromAddress(addr);
      if (!injector.signer || !injector.signer.signRaw) throw new Error('this wallet cannot sign raw messages');
      var res = await injector.signer.signRaw({ address: addr, data: U.stringToHex(msg), type: 'bytes' });
      var sig = res.signature;
      // The form may have changed while the wallet was open; a claim must match what is on the page.
      if (!state.ok || typed() || msg !== message() || addr !== address()) throw new Error('the form changed while the wallet was open, sign again');
      // Check what the wallet returned, the way maintainers will: the extension signs <Bytes>message</Bytes>.
      var valid = C.signatureVerify(U.u8aWrapBytes(U.stringToU8a(msg)), sig, addr).isValid;
      showClaim(msg, addr, sig, valid, 'The signature does not verify here. Do not send it. Try again, or use btcli.');
      say(valid ? 'Signed. No funds moved and no transaction was made.' : 'Signing did not verify.', valid ? 'ok' : 'bad');
    } catch (e) { say('Not signed: ' + (e && e.message || e), 'bad'); }
    $('sign').disabled = !state.ok || !!typed();
  });

  // The btcli way: the tester signed the message shown in step 4 on their own machine and pastes the signature.
  // btcli signs <Bytes>message</Bytes> like the extension; the maintainers' checker also accepts the bare message.
  $('sig').addEventListener('input', function () {
    var pasted = $('sig').value.trim(), msg = $('msg').value, addr = address();
    clearClaim();
    if (!pasted || !addr) return;
    // A terminal wraps the signature over two lines, so drop any white space that came with the paste.
    var hex = pasted.replace(/\s+/g, '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
      $('check').textContent = 'That is not a signature. btcli prints 128 hex characters (64 bytes); paste only those.';
      $('check').className = 'bad';
      return;
    }
    var sig = '0x' + hex.toLowerCase(), bytes = U.stringToU8a(msg), valid = false;
    [U.u8aWrapBytes(bytes), bytes].forEach(function (data) {
      try { if (C.signatureVerify(data, sig, addr).isValid) valid = true; } catch (e) { /* not a signature for this key type */ }
    });
    showClaim(msg, addr, sig, valid, 'The signature does not verify here. Do not send it. Sign exactly the message in step 4, with the key of the address in the message.');
  });

  $('copy').addEventListener('click', async function () {
    try { await navigator.clipboard.writeText($('claim').value); say('Copied.', 'ok'); }
    catch (e) { $('claim').select(); say('Select the text and copy it by hand.'); }
  });

  refresh();
})();
