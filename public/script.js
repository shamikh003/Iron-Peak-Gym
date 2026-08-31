/* ===================================================================
   IRONPEAK GYM: public site
   The admission form now posts to the backend API (see server.js).
   Records are stored server-side in SQLite, so the staff dashboard
   sees every submission from any device.
   =================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  /* ---------------------------------------------------------------
     1. Sticky header
  --------------------------------------------------------------- */
  const header = document.getElementById('siteHeader');
  if (header) {
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------------------------------------------------------------
     2. Mobile nav toggle
  --------------------------------------------------------------- */
  const navToggle = document.getElementById('navToggle');
  const nav = document.getElementById('nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      const isOpen = nav.classList.toggle('open');
      navToggle.classList.toggle('open', isOpen);
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });
    nav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        nav.classList.remove('open');
        navToggle.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ---------------------------------------------------------------
     3. Scroll-reveal animations
  --------------------------------------------------------------- */
  const revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    revealEls.forEach(el => revealObserver.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('in-view'));
  }

  /* ---------------------------------------------------------------
     4. Motivation quote rotator
  --------------------------------------------------------------- */
  const quotes = [
    "Discipline is choosing between what you want now and what you want most.",
    "The body achieves what the mind believes.",
    "Small daily reps beat one big effort you never repeat.",
    "You don't have to be extreme, just consistent.",
    "The only bad workout is the one that didn't happen."
  ];
  const quoteBox = document.getElementById('quoteBox');
  if (quoteBox) {
    let quoteIndex = 0;
    setInterval(() => {
      quoteIndex = (quoteIndex + 1) % quotes.length;
      quoteBox.style.opacity = 0;
      setTimeout(() => {
        quoteBox.textContent = `"${quotes[quoteIndex]}"`;
        quoteBox.style.opacity = 1;
      }, 400);
    }, 5000);
  }

  /* ---------------------------------------------------------------
     5. Admission form: validate, then POST to the backend
  --------------------------------------------------------------- */
  const form = document.getElementById('admissionForm');
  if (form) {
    const successMsg = document.getElementById('formSuccess');
    const successClientId = document.getElementById('successClientId');
    const submitBtn = form.querySelector('button[type="submit"]');

    const fields = ['fullName', 'fatherName', 'phone', 'gender', 'dob', 'plan', 'address', 'emergencyContact'];

    const validators = {
      fullName: v => v.trim().length >= 3,
      fatherName: v => v.trim().length >= 3,
      phone: v => /^[0-9+\s-]{10,15}$/.test(v.trim()),
      email: v => v.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
      gender: v => v !== '',
      dob: v => v !== '',
      plan: v => v !== '',
      address: v => v.trim().length >= 5,
      emergencyContact: v => v.trim().length >= 5,
    };

    const errorText = {
      fullName: 'Enter full name (at least 3 characters).',
      fatherName: "Enter father's name.",
      phone: 'Enter a valid phone number.',
      email: 'Enter a valid email address.',
      gender: 'Select a gender.',
      dob: 'Select your date of birth.',
      plan: 'Select a fee plan.',
      address: 'Enter your address.',
      emergencyContact: 'Enter an emergency contact.',
    };

    const validateField = (id) => {
      const input = document.getElementById(id);
      const row = input.closest('.form-row');
      const errorEl = document.getElementById(id + 'Error');
      const isValid = validators[id](input.value);
      row.classList.toggle('invalid', !isValid);
      if (errorEl) errorEl.textContent = isValid ? '' : errorText[id];
      return isValid;
    };

    [...fields, 'email'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('blur', () => validateField(id));
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      successMsg.classList.remove('visible');
      form.classList.remove('has-error');

      const allFields = [...fields, 'email'];
      const results = allFields.map(validateField);
      if (!results.every(Boolean)) {
        const firstInvalid = form.querySelector('.form-row.invalid input, .form-row.invalid select');
        if (firstInvalid) firstInvalid.focus();
        return;
      }

      const [planName] = document.getElementById('plan').value.split('|');
      const payload = {
        name: document.getElementById('fullName').value.trim(),
        fatherName: document.getElementById('fatherName').value.trim(),
        phone: document.getElementById('phone').value.trim(),
        email: document.getElementById('email').value.trim(),
        cnic: document.getElementById('cnic').value.trim(),
        gender: document.getElementById('gender').value,
        dob: document.getElementById('dob').value,
        address: document.getElementById('address').value.trim(),
        emergencyContact: document.getElementById('emergencyContact').value.trim(),
        plan: planName,
      };

      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';

      try {
        const res = await fetch('/api/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          // Map any server-side field errors back onto the form
          let data = {};
          try { data = await res.json(); } catch { /* ignore */ }
          if (data.errors) {
            const map = {
              name: 'fullName', fatherName: 'fatherName', phone: 'phone', email: 'email',
              gender: 'gender', dob: 'dob', plan: 'plan', address: 'address',
              emergencyContact: 'emergencyContact',
            };
            Object.entries(data.errors).forEach(([serverKey, msg]) => {
              const id = map[serverKey];
              if (!id) return;
              const row = document.getElementById(id)?.closest('.form-row');
              const errorEl = document.getElementById(id + 'Error');
              if (row) row.classList.add('invalid');
              if (errorEl) errorEl.textContent = msg;
            });
          }
          throw new Error('Validation failed');
        }

        const data = await res.json();
        successClientId.textContent = data.id;
        successMsg.textContent = '';
        successMsg.innerHTML = 'Admission submitted successfully! Your client ID: <strong id="successClientId"></strong>. It has been recorded in the staff dashboard.';
        successMsg.querySelector('#successClientId').textContent = data.id;
        successMsg.classList.add('visible');
        form.reset();
        successMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        // Network / server unreachable, or validation error already shown on fields
        if (err.message !== 'Validation failed') {
          successMsg.innerHTML = '';
          successMsg.textContent = 'Could not submit. Connection to the server failed. Please try again in a moment.';
          successMsg.classList.add('visible', 'error');
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
    });
  }

  /* ---------------------------------------------------------------
     6. Footer year
  --------------------------------------------------------------- */
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

});
