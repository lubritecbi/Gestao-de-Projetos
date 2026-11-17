'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null;

  async function post(url, body, withCsrf) {
    const headers = { 'Content-Type': 'application/json' };
    if (withCsrf && csrf) headers['X-CSRF-Token'] = csrf;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
    let data = {};
    try { data = await r.json(); } catch { /* vazio */ }
    if (!r.ok) throw new Error(data.error || 'Não foi possível concluir. Tente novamente.');
    return data;
  }

  function mostrarTroca() {
    $('form-login').hidden = true;
    $('form-troca').hidden = false;
    $('atual').focus();
  }

  // Sessão já aberta (ex.: veio redirecionado para trocar a senha)
  fetch('/api/auth/me', { credentials: 'same-origin' }).then(async (r) => {
    if (!r.ok) return;
    const d = await r.json();
    csrf = d.csrfToken;
    if (d.user.mustChangePassword) mostrarTroca(); else location.replace('./');
  }).catch(() => {});

  fetch('/api/auth/policy').then((r) => r.json()).then((p) => {
    $('regra').textContent = `Mínimo de ${p.minLength} caracteres, com minúsculas, maiúsculas, números e símbolos.`;
  }).catch(() => {});

  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; $('erro-login').textContent = '';
    try {
      const d = await post('/api/auth/login', { email: $('email').value.trim(), password: $('senha').value });
      csrf = d.csrfToken;
      $('senha').value = '';
      if (d.user.mustChangePassword) mostrarTroca(); else location.replace('./');
    } catch (err) {
      $('erro-login').textContent = err.message;
      $('senha').value = ''; $('senha').focus();
    } finally { btn.disabled = false; }
  });

  $('form-troca').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; $('erro-troca').textContent = '';
    if ($('nova').value !== $('confirma').value) { $('erro-troca').textContent = 'A confirmação não confere com a nova senha.'; return; }
    btn.disabled = true;
    try {
      await post('/api/auth/change-password', { currentPassword: $('atual').value, newPassword: $('nova').value }, true);
      location.replace('./');
    } catch (err) { $('erro-troca').textContent = err.message; } finally { btn.disabled = false; }
  });
})();
