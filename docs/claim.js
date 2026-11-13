// Transit Fabric claim page. Signs one text message with a browser wallet (signRaw, type "bytes").
// No transaction, no network request. The wallet libraries are the three pinned, SRI-checked scripts
// in claim.html (@polkadot/util 14.0.3, @polkadot/util-crypto 14.0.3, @polkadot/extension-dapp 0.64.1).
(function () {
  'use strict';
  if (window.top !== window.self) { document.body.textContent = 'This page must not be framed.'; return; }
  var $ = function (id) { return document.getElementById(id); };
  var U = window.polkadotUtil, C = window.polkadotUtilCrypto, D = window.polkadotExtensionDapp;
  var GH = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  var state = { accounts: [], signature: null };

  function say(text, cls) { var s = $('status'); s.textContent = text; s.className = cls || ''; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function message() {
    var gh = $('gh').value.trim(), addr = $('acct').value;
    return 'Transit Fabric bounty: github=' + gh + ', address=' + addr + ', date=' + today();
  }
  function refresh() {
    var gh = $('gh').value.trim(), addr = $('acct').value, ok = GH.test(gh) && !!addr;
    $('msg').value = ok ? message() : (gh && !GH.test(gh) ? 'That is not a valid GitHub username.' : 'Fill in your username and connect a wallet.');
    $('sign').disabled = !ok;
    state.signature = null;
    $('claim').value = ''; $('check').textContent = ''; $('copy').disabled = true; $('issue').hidden = true;
  }

  $('gh').addEventListener('input', refresh);
  $('acct').addEventListener('change', refresh);

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
    var addr = $('acct').value, msg = message();
    $('sign').disabled = true;
    say('Approve the signature request in your wallet. It shows plain text and no transaction.');
    try {
      var injector = await D.web3FromAddress(addr);
      if (!injector.signer || !injector.signer.signRaw) throw new Error('this wallet cannot sign raw messages');
      var res = await injector.signer.signRaw({ address: addr, data: U.stringToHex(msg), type: 'bytes' });
      var sig = res.signature;
      // Check what the wallet returned, the way maintainers will: the extension signs <Bytes>message</Bytes>.
      var valid = C.signatureVerify(U.u8aWrapBytes(U.stringToU8a(msg)), sig, addr).isValid;
      state.signature = sig;
      var block = 'message: ' + msg + '\naddress: ' + addr + '\nsignature: ' + sig + '\n';
      $('claim').value = block;
      $('check').textContent = valid ? 'Checked in this page: the signature is valid for this message and address.' : 'The signature does not verify here. Do not send it. Try again, or use btcli.';
      $('check').className = valid ? 'ok' : 'bad';
      $('copy').disabled = !valid;
      if (valid) {
        var q = new URLSearchParams({ template: 'registration.yml', title: 'Bounty registration', labels: 'bounty-registration', github: $('gh').value.trim(), address: addr, message: msg, signature: sig });
        var a = $('issue');
        a.href = 'https://github.com/transitfabric/releases/issues/new?' + q.toString();
        a.hidden = false;
      }
      say(valid ? 'Signed. No funds moved and no transaction was made.' : 'Signing did not verify.', valid ? 'ok' : 'bad');
    } catch (e) { say('Not signed: ' + (e && e.message || e), 'bad'); }
    $('sign').disabled = false;
  });

  $('copy').addEventListener('click', async function () {
    try { await navigator.clipboard.writeText($('claim').value); say('Copied.', 'ok'); }
    catch (e) { $('claim').select(); say('Select the text and copy it by hand.'); }
  });

  refresh();
  var tmpl = 'btcli wallet sign --wallet-name <your wallet> --no-use-hotkey --message \'<message from step 3>\'';
  $('btcli').textContent = tmpl;
  [$('gh'), $('acct')].forEach(function (el) { el.addEventListener('input', function () {
    if (state.accounts.length && GH.test($('gh').value.trim())) $('btcli').textContent = 'btcli wallet sign --wallet-name <your wallet> --no-use-hotkey --message \'' + message() + '\'';
  }); });
})();
