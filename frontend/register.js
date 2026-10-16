'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('registerForm');
  const stateSelect = document.getElementById('state');
  const lgaSelect = document.getElementById('lga');
  const wardSelect = document.getElementById('ward');
  const pollingSelect = document.getElementById('pollingUnit');
  const locationMessage = document.getElementById('locationMessage');
  const formMessage = document.getElementById('formMessage');

  if (!form || !stateSelect || !lgaSelect || !wardSelect || !pollingSelect) {
    console.error('Registration form is missing a required location field.');
    return;
  }

  const cache = { states: [], lgas: [], wards: [] };
  let stateRequestId = 0;
  let lgaRequestId = 0;
  let wardRequestId = 0;

  function showMessage(text) {
    if (locationMessage) locationMessage.textContent = text;
  }

  function resetSelect(select, text) {
    select.replaceChildren(new Option(text, ''));
    select.disabled = true;
  }

  function fillSelect(select, records, placeholder) {
    select.replaceChildren(new Option(placeholder, ''));

    for (const item of records) {
      const option = new Option(item.name, item.id);
      option.dataset.code = item.code;
      select.add(option);
    }

    select.disabled = records.length === 0;
  }

  async function fetchRecords(url) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    const result = await response.json();

    if (result.success !== true || !Array.isArray(result.data)) {
      throw new Error(result.message || 'Unexpected location response');
    }

    return result.data;
  }

  async function loadStates() {
    resetSelect(stateSelect, 'Loading states...');
    resetSelect(lgaSelect, 'Select a state first');
    resetSelect(wardSelect, 'Select an LGA first');
    resetSelect(pollingSelect, 'Select a ward first');
    showMessage('Loading states and FCT...');

    try {
      cache.states = await fetchRecords('/api/locations/states');
      fillSelect(stateSelect, cache.states, 'Select state or FCT');
      stateSelect.disabled = false;
      showMessage(`Loaded ${cache.states.length} states and FCT.`);
    } catch (error) {
      resetSelect(stateSelect, 'Unable to load states');
      showMessage(`State loading failed: ${error.message}`);
      console.error('State loading failed:', error);
    }
  }

  stateSelect.addEventListener('change', async () => {
    const requestId = ++stateRequestId;
    ++lgaRequestId;
    ++wardRequestId;
    resetSelect(lgaSelect, 'Loading LGAs...');
    resetSelect(wardSelect, 'Select an LGA first');
    resetSelect(pollingSelect, 'Select a ward first');
    cache.lgas = [];
    cache.wards = [];

    if (!stateSelect.value) {
      resetSelect(lgaSelect, 'Select a state first');
      showMessage('Select a state or FCT.');
      return;
    }

    const selectedState = stateSelect.value;
    showMessage('Loading Local Government Areas...');

    try {
      const records = await fetchRecords(
        `/api/locations/lgas?state=${encodeURIComponent(selectedState)}`
      );

      if (requestId !== stateRequestId || stateSelect.value !== selectedState) return;

      cache.lgas = records;
      fillSelect(lgaSelect, records, 'Select Local Government Area');
      showMessage(records.length ? `${records.length} LGAs loaded.` : 'No LGAs returned.');
    } catch (error) {
      resetSelect(lgaSelect, 'Unable to load LGAs');
      showMessage(`LGA loading failed: ${error.message}`);
      console.error('LGA loading failed:', error);
    }
  });

  lgaSelect.addEventListener('change', async () => {
    const requestId = ++lgaRequestId;
    ++wardRequestId;
    resetSelect(wardSelect, 'Loading wards...');
    resetSelect(pollingSelect, 'Select a ward first');
    cache.wards = [];

    if (!lgaSelect.value) {
      resetSelect(wardSelect, 'Select an LGA first');
      showMessage('Select a Local Government Area.');
      return;
    }

    const selectedLga = lgaSelect.value;
    showMessage('Loading wards...');

    try {
      const records = await fetchRecords(
        `/api/locations/wards?lga=${encodeURIComponent(selectedLga)}`
      );

      if (requestId !== lgaRequestId || lgaSelect.value !== selectedLga) return;

      cache.wards = records;
      fillSelect(wardSelect, records, 'Select ward');
      showMessage(records.length ? `${records.length} wards loaded.` : 'No wards returned.');
    } catch (error) {
      resetSelect(wardSelect, 'Unable to load wards');
      showMessage(`Ward loading failed: ${error.message}`);
      console.error('Ward loading failed:', error);
    }
  });

  wardSelect.addEventListener('change', async () => {
    const requestId = ++wardRequestId;
    resetSelect(pollingSelect, 'Loading polling units...');

    if (!wardSelect.value) {
      resetSelect(pollingSelect, 'Select a ward first');
      showMessage('Select a ward.');
      return;
    }

    const state = cache.states.find(item => String(item.id) === String(stateSelect.value));
    const lga = cache.lgas.find(item => String(item.id) === String(lgaSelect.value));
    const ward = cache.wards.find(item => String(item.id) === String(wardSelect.value));

    if (!state || !lga || !ward) {
      resetSelect(pollingSelect, 'Select a ward first');
      showMessage('Please reselect your state, LGA and ward.');
      return;
    }

    const selectedWard = wardSelect.value;
    showMessage('Loading polling units...');

    try {
      const params = new URLSearchParams({
        state: state.code,
        lga: lga.code,
        ward: ward.code
      });

      const records = await fetchRecords(
        `/api/locations/polling-units?${params.toString()}`
      );

      if (requestId !== wardRequestId || wardSelect.value !== selectedWard) return;

      fillSelect(
        pollingSelect,
        records,
        records.length ? 'Select polling unit (optional)' : 'No polling units found'
      );

      showMessage(records.length
        ? `${records.length} polling units loaded.`
        : 'No polling units found for this ward.');
    } catch (error) {
      resetSelect(pollingSelect, 'Unable to load polling units');
      showMessage(`Polling-unit loading failed: ${error.message}`);
      console.error('Polling-unit loading failed:', error);
    }
  });

  const otherRole = document.getElementById('otherRole');
  const otherRoleField = document.getElementById('otherRoleField');
  const otherRoleText = document.getElementById('otherRoleText');

  if (otherRole && otherRoleField && otherRoleText) {
    otherRole.addEventListener('change', () => {
      otherRoleField.hidden = !otherRole.checked;
      otherRoleText.required = otherRole.checked;
      if (!otherRole.checked) otherRoleText.value = '';
    });
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type=submit]');
    const values = new FormData(form);
    const roles = values.getAll('roles');
    const state = cache.states.find(x => String(x.id) === String(stateSelect.value));
    const lga = cache.lgas.find(x => String(x.id) === String(lgaSelect.value));
    const ward = cache.wards.find(x => String(x.id) === String(wardSelect.value));
    if (!state || !lga || !ward) { if (formMessage) formMessage.textContent = 'Please select State, LGA and Ward from the loaded lists.'; return; }
    if (values.get('password') !== values.get('confirmPassword')) { if (formMessage) formMessage.textContent = 'Passwords do not match.'; return; }
    const payload = { name: values.get('name'), phone: values.get('phone'), email: values.get('email'), password: values.get('password'), confirmPassword: values.get('confirmPassword'), address: values.get('address'), preferredLanguage: values.get('preferredLanguage') || 'English', state: state.id, lga: lga.id, ward: ward.id, pollingUnit: values.get('pollingUnit') || '', roles, otherRoleText: values.get('otherRoleText') || '', acceptTerms: values.has('acceptTerms'), acceptPrivacy: values.has('acceptPrivacy') };
    if (button) { button.disabled = true; button.textContent = 'Creating account...'; }
    if (formMessage) formMessage.textContent = '';
    try {
      const response = await fetch('/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Registration failed. Please try again.');
      if (formMessage) formMessage.textContent = result.message || 'Account created. Check your email to verify it.';
      if (response.ok && result.emailDelivery) form.reset();
    } catch (error) { if (formMessage) formMessage.textContent = error.message || 'Could not create account. Please try again.'; }
    finally { if (button) { button.disabled = false; button.textContent = 'Register Now'; } }
  });

  loadStates();
});
