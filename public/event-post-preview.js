const FRENCH_ERRORS = {
  event_draft_invalid: 'Le brouillon est invalide.',
  event_draft_unavailable: 'Le brouillon n’est plus disponible.',
  event_finished: 'L’événement est terminé.',
  event_need_full: 'Le besoin est complet.',
  event_places_required: 'Indiquez le nombre de places.',
  event_places_invalid: 'Le nombre de places est invalide.',
  event_window_too_short: 'La fenêtre de publication est trop courte.',
  event_duration_invalid: 'La durée sélectionnée est invalide.',
  event_note_invalid: 'La note publique est invalide.',
  event_note_too_long: 'La note publique est trop longue.',
  event_plan_changed: 'Le plan a changé.',
  login_required: 'Connexion requise.',
  rules_acceptance_required: 'Vous devez accepter les règles.',
  rules_version_changed: 'La version des règles a changé.',
  own_post_capacity_reached: 'Capacité de publication atteinte.',
  invalid_post_response: 'Réponse de publication invalide.',
  request_failed: 'Échec de la demande.'
};

const ALL_DURATIONS = [30, 60, 120, 240];

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = clone(value[key]);
  }
  return out;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) deepFreeze(value[key]);
  }
  return value;
}

function publicResult(result) {
  if (!result) return null;
  if (!result.ok) return { ok: false, code: result.code };
  return {
    ok: true,
    draft: clone(result.draft),
    remaining: result.remaining,
    allowedDurations: clone(result.allowedDurations)
  };
}

export class EventPostPreviewState {
  constructor({ derive, send, makeKey, onChange = () => {}, role, cityLabel, remaining }) {
    if (typeof derive !== 'function') throw new TypeError('derive must be a function');
    if (typeof send !== 'function') throw new TypeError('send must be a function');
    if (typeof makeKey !== 'function') throw new TypeError('makeKey must be a function');
    this._derive = derive;
    this._send = send;
    this._makeKey = makeKey;
    this._onChange = onChange;
    this._role = role;
    this._cityLabel = cityLabel;
    this._remaining = remaining;
    this._epoch = 0;
    this._options = {};
    this._phase = 'editing';
    this._errorCode = null;
    this._postId = null;
    this._intent = null;
    this._busy = false;
    this._result = this._safeDerive(this._options);
  }

  _safeDerive(options) {
    try {
      const clonedOptions = clone(options);
      const result = this._derive(clonedOptions);
      return result && typeof result.ok === 'boolean' ? clone(result) : { ok: false, code: 'event_draft_invalid' };
    } catch (e) {
      return { ok: false, code: 'event_draft_invalid' };
    }
  }

  _notify() {
    this._onChange(this.snapshot());
  }

  snapshot() {
    return {
      role: this._role,
      cityLabel: this._cityLabel,
      remaining: this._remaining,
      options: clone(this._options),
      result: publicResult(this._result),
      phase: this._phase,
      errorCode: this._errorCode,
      postId: this._postId,
      busy: this._busy
    };
  }

  edit(partial) {
    if (this._busy || this._phase === 'uncertain' || this._phase === 'success') return false;
    const next = clone(this._options);
    const clonedPartial = clone(partial);
    for (const key of ['places', 'durationMinutes', 'extraNote']) {
      if (Object.prototype.hasOwnProperty.call(clonedPartial, key)) {
        if (clonedPartial[key] === undefined) delete next[key];
        else next[key] = clonedPartial[key];
      }
    }
    this._options = next;
    this._errorCode = null;
    this._result = this._safeDerive(this._options);
    this._notify();
    return true;
  }

  async publish() {
    if (this._busy) return false;
    if (this._phase === 'success') return false;
    if (this._phase === 'uncertain') {
      if (!this._intent) return false;
      this._busy = true;
      this._phase = 'sending';
      this._notify();
      const epoch = this._epoch;
      const intent = this._intent;
      let outcome;
      try {
        outcome = await this._send({
          draft: clone(intent.draft),
          source: clone(intent.source),
          key: intent.key,
          retry: true
        });
      } catch (err) {
        if (epoch !== this._epoch) return false;
        this._handleError(err, true);
        return false;
      }
      if (epoch !== this._epoch) return false;
      return this._handleSuccess(outcome);
    }
    const fresh = this._safeDerive(this._options);
    this._result = fresh;
    if (!fresh.ok) {
      this._errorCode = fresh.code || 'event_draft_invalid';
      this._notify();
      return false;
    }
    const key = this._makeKey();
    this._intent = deepFreeze({
      draft: clone(fresh.draft),
      source: clone(fresh.source),
      key
    });
    this._busy = true;
    this._phase = 'sending';
    this._notify();
    const epoch = this._epoch;
    const intent = this._intent;
    let outcome;
    try {
      outcome = await this._send({
        draft: clone(intent.draft),
        source: clone(intent.source),
        key: intent.key,
        retry: false
      });
    } catch (err) {
      if (epoch !== this._epoch) return false;
      this._handleError(err);
      return false;
    }
    if (epoch !== this._epoch) return false;
    return this._handleSuccess(outcome);
  }

  _handleSuccess(outcome) {
    if (!outcome || typeof outcome.post !== 'object' || outcome.post === null ||
        typeof outcome.post.id !== 'string' || outcome.post.id.length === 0) {
      this._errorCode = 'invalid_post_response';
      this._busy = false;
      this._phase = 'uncertain';
      this._notify();
      return false;
    }
    this._phase = 'success';
    this._postId = outcome.post.id;
    this._intent = null;
    this._errorCode = null;
    this._busy = false;
    this._notify();
    return true;
  }

  _handleError(err, retry = false) {
    const code = (err && typeof err.code === 'string' && err.code.length) ? err.code : 'request_failed';
    const status = err && typeof err.status === 'number' ? err.status : null;
    const isIntegerStatus = status !== null && Number.isInteger(status);
    const definitive = (err && err.definitive === true) || (isIntegerStatus && status >= 400 && status <= 499);
    // A refusal of a retry does not prove that the original request failed.
    // Retain its exact key/body until its outcome is actually confirmed.
    if (definitive && !retry) {
      this._intent = null;
      this._busy = false;
      this._phase = 'editing';
      this._errorCode = code;
      this._notify();
    } else {
      this._busy = false;
      this._phase = 'uncertain';
      this._errorCode = code;
      this._notify();
    }
  }

  reset() {
    this._epoch++;
    this._options = {};
    this._phase = 'editing';
    this._errorCode = null;
    this._postId = null;
    this._intent = null;
    this._busy = false;
    this._result = this._safeDerive(this._options);
    this._notify();
  }
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

export function renderEventPostPreview(view) {
  const role = escapeHtml(view.role === undefined || view.role === null ? '' : view.role);
  const city = escapeHtml(view.cityLabel === undefined || view.cityLabel === null ? '' : view.cityLabel);
  const remaining = typeof view.remaining === 'number' && view.remaining >= 0 ? view.remaining : 0;
  const phase = view.phase || 'editing';
  const errorCode = view.errorCode || (view.result?.ok === false ? view.result.code : null);
  const busy = !!view.busy;
  const options = view.options || {};
  const result = view.result || null;
  const ok = result && result.ok !== false;
  const draft = ok ? result.draft : null;
  const allowedDurations = ok && Array.isArray(result.allowedDurations) ? result.allowedDurations : ALL_DURATIONS;
  const noteText = draft && typeof draft.note === 'string' ? draft.note : '';
  const extraNote = typeof options.extraNote === 'string' ? options.extraNote : '';
  const placesValue = options.places !== undefined ? options.places : (draft ? draft.places : undefined);
  const durationValue = options.durationMinutes !== undefined ? options.durationMinutes : (draft ? draft.durationMinutes : undefined);
  const maxPlaces = Math.min(8, remaining);
  const editingDisabled = busy || phase === 'uncertain' || phase === 'success';
  const submitDisabled = busy || !ok;
  const errorText = !errorCode ? null : Object.prototype.hasOwnProperty.call(FRENCH_ERRORS, errorCode) ? FRENCH_ERRORS[errorCode] : 'La demande n’a pas abouti. Votre saisie est conservée.';

  let html = '<h2 id="event-post-preview-title">Relire l’annonce publique</h2>';
  html += '<p class="event-help">Cette annonce sera indépendante de l’événement. Les confirmations manuelles ne changent pas.</p>';
  html += '<p class="field-label">Rôle : ' + role + ' · Ville : ' + city + '</p>';
  html += '<p class="event-help">Le lieu exact et les instructions privées ne sont pas copiés dans l’annonce publique.</p>';
  if (noteText) {
    html += '<p class="field-label">Note publique actuelle</p>';
    html += '<p class="event-post-review">' + escapeHtml(noteText) + '</p>';
  }
  html += '<p class="event-help">Les dates d’événement dans la note sont distinctes de la durée de publication à partir de maintenant.</p>';

  if (ok && draft) {
    const summaryPlaces = draft.places !== undefined ? draft.places : '';
    const summaryDuration = draft.durationMinutes !== undefined ? draft.durationMinutes : '';
    html += '<p class="event-help">Résumé : ' + escapeHtml(summaryPlaces) + ' places, visible pendant ' + escapeHtml(summaryDuration) + ' minutes.</p>';
  }

  if (phase === 'success') {
    html += '<p role="status">Annonce publiée. Les confirmations de l’événement restent inchangées.</p>';
    html += '<div class="event-columns">';
    html += '<button type="button" class="button lime" data-preview-action="view">Voir mon annonce</button>';
    html += '<button type="button" class="button outline" data-preview-action="new">Préparer une autre annonce</button>';
    html += '</div>';
    return html;
  }

  if (phase === 'uncertain') {
    html += '<p role="status">Résultat non confirmé. Vérifiez la même tentative pour éviter un doublon.</p>';
    if (errorText) html += '<p class="form-error" role="alert">' + escapeHtml(errorText) + '</p>';
    html += '<button type="button" class="button lime" data-preview-action="retry">Vérifier la publication</button>';
    return html;
  }

  html += '<form id="event-post-preview-form">';
  html += '<div class="event-columns">';
  html += '<div><label class="field-label" for="event-post-preview-places">Places dans cette annonce</label>';
  html += '<select id="event-post-preview-places" name="places"' + (editingDisabled ? ' disabled' : '') + '>';
  html += '<option value="">Choisir</option>';
  for (let i = 1; i <= maxPlaces; i++) {
    const sel = placesValue === i ? ' selected' : '';
    html += '<option value="' + escapeAttr(i) + '"' + sel + '>' + escapeHtml(i) + '</option>';
  }
  html += '</select></div>';
  html += '<div><label class="field-label" for="event-post-preview-duration">Visible pendant</label>';
  html += '<select id="event-post-preview-duration" name="durationMinutes"' + (editingDisabled ? ' disabled' : '') + '>';
  if (durationValue === undefined) html += '<option value="">Choisir</option>';
  for (const d of allowedDurations) {
    const sel = durationValue === d ? ' selected' : '';
    html += '<option value="' + escapeAttr(d) + '"' + sel + '>' + escapeHtml(d) + ' minutes</option>';
  }
  html += '</select></div>';
  html += '</div>';
  html += '<label class="field-label" for="event-post-preview-note">Note publique supplémentaire · facultatif</label>';
  html += '<p class="event-help">180 caractères maximum pour la note complète, dates et langues incluses.</p>';
  html += '<textarea id="event-post-preview-note" name="extraNote" maxlength="180"' + (editingDisabled ? ' disabled' : '') + '>' + escapeHtml(extraNote) + '</textarea>';
  if (errorText) html += '<p class="form-error" role="alert">' + escapeHtml(errorText) + '</p>';
  else if (!ok) html += '<p class="form-error" role="alert">Le brouillon est invalide.</p>';
  const submitLabel = busy ? 'Publication en cours…' : 'Publier cette annonce';
  if (busy) html += '<p role="status">Publication en cours…</p>';
  html += '<button type="submit" class="button lime"' + (submitDisabled ? ' disabled' : '') + '>' + escapeHtml(submitLabel) + '</button>';
  html += '</form>';
  return html;
}
