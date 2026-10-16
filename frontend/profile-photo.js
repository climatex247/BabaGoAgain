'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const galleryInput = document.getElementById('profilePhoto');
  const cameraInput = document.getElementById('cameraPhoto');
  const takePhotoButton = document.getElementById('takePhotoButton');
  const chooseGalleryButton = document.getElementById('chooseGalleryButton');
  const container = document.getElementById('photoPreviewContainer');
  const preview = document.getElementById('photoPreview');
  const remove = document.getElementById('removePhoto');
  const message = document.getElementById('photoMessage');
  if (!galleryInput || !cameraInput || !takePhotoButton || !chooseGalleryButton || !container || !preview || !remove) return;

  let previewUrl = null;
  let activeInput = galleryInput;
  takePhotoButton.addEventListener('click', () => cameraInput.click());
  chooseGalleryButton.addEventListener('click', () => galleryInput.click());

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    preview.removeAttribute('src');
    container.hidden = true;
  }

  function handleSelection(event) {
    const input = event.currentTarget;
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      input.value = '';
      if (message) message.textContent = 'Please select an image file.';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      input.value = '';
      if (message) message.textContent = 'The photo must be 5 MB or smaller.';
      return;
    }
    clearPreview();
    activeInput = input;
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    container.hidden = false;
    if (message) message.textContent = 'Photo selected successfully. It will only be saved when registration is connected.';
  }
  galleryInput.addEventListener('change', handleSelection);
  cameraInput.addEventListener('change', handleSelection);
  remove.addEventListener('click', () => {
    galleryInput.value = '';
    cameraInput.value = '';
    clearPreview();
    if (message) message.textContent = 'Photo removed.';
    activeInput = galleryInput;
  });
});
