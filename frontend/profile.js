'use strict';

const form = document.getElementById('profileForm');
const statusBox = document.getElementById('status');
const saveButton = document.getElementById('save');

function message(text, error = false) {
  statusBox.textContent = text;
  statusBox.style.color = error ? '#b91c1c' : '#166534';
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    if (response.status === 401 || response.status === 403) {
      location.href = '/login.html';
    }
    throw new Error(data.message || 'Request failed.');
  }
  return data;
}

async function loadProfile() {
  try {
    const { data: p } = await api('/api/member-profile');
    ['name', 'phone', 'address', 'preferredLanguage'].forEach(key => {
      document.getElementById(key).value =
        p[key] || (key === 'preferredLanguage' ? 'English' : '');
    });

    ['stateName', 'lgaName', 'wardName', 'pollingUnitId'].forEach(key => {
      document.getElementById(key).textContent = p[key] || 'Not provided';
    });

    document.getElementById('roles').textContent =
      Array.isArray(p.roles) && p.roles.length ? p.roles.join(', ') : 'Member';

    document.getElementById('joinedAt').textContent =
      p.joinedAt ? new Date(p.joinedAt).toLocaleDateString() : '—';
  } catch (error) {
    message(error.message, true);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  saveButton.disabled = true;
  message('Saving profile…');

  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    const result = await api('/api/member-profile', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    message(result.message || 'Profile saved.');
  } catch (error) {
    message(error.message, true);
  } finally {
    saveButton.disabled = false;
  }
});

loadProfile();
