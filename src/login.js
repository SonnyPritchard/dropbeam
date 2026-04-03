// login.js — runs in the login.html renderer

const SERVER = window.dropbeam?.auth?.getServerUrl?.() || 'http://localhost:3001';

function switchTab(tab) {
  document.getElementById('tab-signin').classList.toggle('active', tab === 'signin');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  document.getElementById('panel-signin').classList.toggle('active', tab === 'signin');
  document.getElementById('panel-signup').classList.toggle('active', tab === 'signup');
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.add('visible');
}

function clearError(id) {
  const el = document.getElementById(id);
  el.textContent = '';
  el.classList.remove('visible');
}

// Enter key support
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const signinActive = document.getElementById('panel-signin').classList.contains('active');
  if (signinActive) doSignIn();
  else doSignUp();
});

async function doSignIn() {
  clearError('signin-error');
  const email = document.getElementById('signin-email').value.trim();
  const password = document.getElementById('signin-password').value;
  if (!email || !password) { showError('signin-error', 'Please fill in all fields.'); return; }

  setLoading('signin-btn', true);
  try {
    const res = await fetch(`${SERVER}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Login failed');
    await window.dropbeam.auth.saveToken(data.token, data.user);
    await window.dropbeam.auth.loadApp();
  } catch (err) {
    showError('signin-error', err.message);
  } finally {
    setLoading('signin-btn', false);
  }
}

async function doSignUp() {
  clearError('signup-error');
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  if (!name || !email || !password) { showError('signup-error', 'Please fill in all fields.'); return; }

  setLoading('signup-btn', true);
  try {
    const res = await fetch(`${SERVER}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Signup failed');
    await window.dropbeam.auth.saveToken(data.token, data.user);
    await window.dropbeam.auth.loadApp();
  } catch (err) {
    showError('signup-error', err.message);
  } finally {
    setLoading('signup-btn', false);
  }
}
