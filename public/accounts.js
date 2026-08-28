import { requestJSON } from './requests.js';

// Authentication stays in an HttpOnly cookie. This view never stores passwords,
// recovery codes or session tokens in browser storage.
export function createAccountUI({ openDialog, onChange, onError }) {
  const dialog = document.querySelector('#account');
  const $ = selector => dialog.querySelector(selector);
  let session = { mode: 'demo', user: null }, mode = 'login', busy = false, resume, readRevision=0;
  const labels = {
    login: ['Heureux de vous revoir.', 'Connectez-vous pour retrouver vos annonces et vos échanges.', 'Se connecter'],
    register: ['Un compte. Et c’est parti.', 'Un pseudo et une phrase secrète. Aucun CV à remplir.', 'Créer mon compte gratuit'],
    recover: ['Retrouver votre compte.', 'Utilisez le code de secours reçu à la création du compte.', 'Récupérer mon compte'],
  };
  function render(next = mode) {
    if (resume === showDeletion && next === 'register') next = 'login';
    mode = next;
    const signedIn = Boolean(session.user);
    $('#account-signed-in').hidden = !signedIn;
    $('#account-auth').hidden = signedIn;
    $('#account-recovery').hidden = true;
    $('#account-error').hidden = true;
    $('#account-title').textContent = signedIn ? 'Votre compte.' : labels[mode][0];
    $('#account-description').textContent = signedIn ? `Connecté avec le pseudo ${session.user.username}.` : labels[mode][1];
    if (signedIn) return;
    $('#account-username-field').hidden = mode === 'recover';
    $('#account-username').required = mode !== 'recover';
    $('#account-code-field').hidden = mode !== 'recover';
    $('#account-code').required = mode === 'recover';
    $('#account-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#account-password').minLength = mode === 'login' ? 1 : 15;
    $('#account-password-label').textContent = mode === 'recover' ? 'Nouvelle phrase secrète' : 'Phrase secrète';
    $('#account-password-help').hidden = mode === 'login';
    $('#account-submit').textContent = labels[mode][2];
    $('#account-consent').hidden = mode !== 'register';
    $('#account-terms').required = mode === 'register';
    dialog.querySelectorAll('[data-auth-mode]').forEach(button => {
      button.hidden = resume === showDeletion && button.dataset.authMode === 'register';
      button.classList.toggle('active', button.dataset.authMode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.authMode === mode));
    });
  }
  function show(next = 'login', continuation) {
    resume = continuation; $('#account-form').reset(); $('#delete-account-form').reset(); $('#delete-account-details').open = false;
    render(next); openDialog(dialog);
  }
  function showDeletion() {
    show('login', showDeletion);
    if (session.user) {
      resume = undefined;
      $('#delete-account-details').open = true;
      $('#delete-password').focus();
    } else {
      $('#account-description').textContent = 'Connectez-vous au compte thesocialextra à supprimer. Rien ne sera effacé avant votre confirmation.';
      $('#account-username').focus();
    }
  }
  async function refresh() {
    const revision=++readRevision;let next;
    try { next = await requestJSON('/api/session'); }
    catch (error) { if (error.status === 404) next = { mode: 'demo', user: null }; else throw error; }
    if(revision!==readRevision)return session;
    session=next;
    await onChange(session);
    return session;
  }
  async function applyAuthResult(user) {
    ++readRevision;session={mode:'production',user,ownership:[],moderator:false};
    await onChange(session);
  }
  function setBusy(value) {
    busy = value;
    dialog.querySelectorAll('button').forEach(button => { button.disabled = value; });
  }
  function finish() {
    $('#recovery-code').value = '';
    const continuation = resume; resume = undefined;
    dialog.close(); continuation?.();
  }
  dialog.addEventListener('cancel', event => { if (busy || !$('#account-recovery').hidden) event.preventDefault(); });
  dialog.addEventListener('click',event=>{if(event.target===dialog&&(busy||!$('#account-recovery').hidden))event.stopImmediatePropagation();},true);
  dialog.addEventListener('close', () => {
    // Native close events may arrive after a continuation has reopened the dialog.
    if (dialog.open) return;
    resume = undefined; $('#account-password').value = ''; $('#account-code').value = '';
    $('#delete-account-form').reset(); $('#delete-account-details').open = false;
  });
  $('#cancel-delete-account').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => { if (!busy) render(button.dataset.authMode); }));
  $('#account-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); ++readRevision; $('#account-error').hidden = true;
    try {
      const payload = mode === 'recover' ? { recoveryCode: $('#account-code').value.trim(), password: $('#account-password').value }
        : { username: $('#account-username').value.trim(), password: $('#account-password').value };
      const result = await requestJSON(`/api/auth/${mode}`, { method: 'POST', body: payload });
      $('#account-form').reset();
      if (result.recoveryCode) {
        $('#account-title').textContent = 'Gardez votre clé de secours.';
        $('#account-description').textContent = 'Elle permet de récupérer le compte si vous oubliez votre phrase secrète. Elle ne sera plus affichée.';
        $('#account-auth').hidden = true; $('#account-signed-in').hidden = true; $('#account-recovery').hidden = false;
        $('#recovery-code').value = result.recoveryCode;
        $('#recovery-saved').checked = false;
        $('#account-close').hidden = true;
      }
      // Display the one-time recovery code before a follow-up read: a failed
      // session refresh must never discard a successfully issued recovery key.
      await applyAuthResult(result.user);
      try { await refresh(); }
      catch (error) { if (resume !== showDeletion || result.recoveryCode) throw error; }
      if (!result.recoveryCode) finish();
    } catch (error) { $('#account-error').textContent = onError(error); $('#account-error').hidden = false; }
    finally { setBusy(false); }
  });
  $('#copy-recovery').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#recovery-code').value); $('#recovery-copy-status').textContent = 'Code copié. Conservez-le dans votre gestionnaire de mots de passe.'; }
    catch { $('#recovery-code').focus(); $('#recovery-code').select(); $('#recovery-copy-status').textContent = 'Sélectionnez et copiez le code dans un endroit sûr.'; }
  });
  $('#recovery-form').addEventListener('submit', event => { event.preventDefault(); $('#account-close').hidden = false; finish(); });
  $('#logout').addEventListener('click', async () => {
    if (busy) return; setBusy(true);
    try { ++readRevision;await requestJSON('/api/auth/logout', { method: 'POST', body: {} }); await applyAuthResult(null); resume = undefined; dialog.close(); }
    catch (error) { $('#account-error').textContent = onError(error); $('#account-error').hidden = false; }
    finally { setBusy(false); }
  });
  $('#delete-account-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !session.user || !$('#delete-confirm').checked || !$('#delete-password').value) return; setBusy(true);++readRevision;
    try {
      await requestJSON('/api/account', { method: 'DELETE', body: { password: $('#delete-password').value } });
      await applyAuthResult(null); resume = undefined; dialog.close();
    } catch (error) { $('#account-error').textContent = onError(error); $('#account-error').hidden = false; }
    finally { setBusy(false); }
  });
  return {
    refresh, show, showDeletion,
    get session() { return session; },
    require(continuation) { if (session.mode !== 'production' || session.user) return true; show('register', continuation); return false; },
  };
}
