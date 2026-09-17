const state = {
  assessments: [],
  current: null,
  modules: [],
  homeworks: [],
  student: null,
  recordedVideo: null,
  mediaRecorder: null,
  recordingStream: null,
  rubricModuleId: null,
  verification: {
    student: { requestId: null, token: null },
    parent: { requestId: null, token: null },
  },
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.detail || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  $(`#${name}-view`).classList.add("active");
  const nav = document.querySelector(`[data-view="${name}"]`);
  if (nav) nav.classList.add("active");
  const titles = {
    admin: "Learning, governed thoughtfully.",
    teacher: "Review before release.",
    student: "Learn with timely feedback.",
    result: "Assessment review.",
  };
  $("#page-title").textContent = titles[name] || "EduGrade AI";
}

async function checkHealth() {
  const element = $("#connection-status");
  try {
    const health = await api("/api/health");
    if (health.azure_configured) {
      element.textContent = `● Azure AI connected · ${health.deployment}`;
      element.className = "connection ready";
    } else {
      element.textContent = "● Azure AI setup required in .env";
      element.className = "connection error";
    }
  } catch {
    element.textContent = "● API unavailable";
    element.className = "connection error";
  }
}

async function loadQueue() {
  const container = $("#queue-list");
  container.innerHTML = '<div class="empty-state">Loading assessments...</div>';
  try {
    state.assessments = await api("/api/assessments");
    const pending = state.assessments.filter((item) =>
      ["needs_review", "ready_for_approval"].includes(item.status)
    );
    $("#review-count").textContent = pending.length;
    $("#metric-review-count").textContent = pending.length;
    if (!state.assessments.length) {
      container.innerHTML = '<div class="empty-state"><h3>No assessments yet</h3><p>Run the demo submission to create the first educator review.</p></div>';
      return;
    }
    container.innerHTML = state.assessments.map((item) => `
      <article class="assessment-card">
        <div>
          <span class="status-badge ${item.status}">${item.status.replaceAll("_", " ")}</span>
          <h3>${escapeHtml(item.input.student_name)}</h3>
          <p>${escapeHtml(item.input.assignment_title)} · ${new Date(item.created_at).toLocaleString()}</p>
        </div>
        <div class="metric"><strong>${item.result.percentage.toFixed(0)}%</strong><span>Grade</span></div>
        <div class="metric"><strong>${(item.result.confidence.score * 100).toFixed(0)}%</strong><span>Confidence</span></div>
        <button class="secondary-button open-assessment" data-id="${item.id}">Review →</button>
      </article>
    `).join("");
    document.querySelectorAll(".open-assessment").forEach((button) => {
      button.addEventListener("click", () => openAssessment(button.dataset.id));
    });
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function listItems(items) {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderTrace(events, liveLabel = "Assessment run completed") {
  $("#trace-live-status").textContent = liveLabel;
  $("#trace-events").innerHTML = events.length
    ? events.map((event) => `
      <div class="trace-event ${event.responsible_ai ? "rai" : ""}">
        ${event.responsible_ai ? '<span class="rai-label">Responsible AI control</span>' : ""}
        <strong>${escapeHtml(event.label)}</strong>
        <span>${escapeHtml(event.detail)}</span>
        <small>${event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "Completed"}</small>
      </div>`).join("")
    : '<div class="trace-empty">No execution trace is available.</div>';
}

function startLiveTrace() {
  const stages = [
    ["Permission and consent", "Verifying stored permissions and submission policy.", true],
    ["Learning module context", "Loading the teacher-approved module and rubric.", false],
    ["External media boundary", "Ensuring raw video remains outside the grading model.", true],
    ["Rubric assessment agent", "Reasoning over the sanitized academic response.", false],
    ["Responsible AI safety check", "Checking child-safe feedback and prohibited inferences.", true],
    ["Confidence governance", "Calculating uncertainty and teacher-review routing.", true],
  ];
  $("#trace-panel").classList.remove("collapsed");
  document.body.classList.add("trace-open");
  $("#trace-live-status").textContent = "Agent execution in progress";
  let visible = 1;
  const draw = () => {
    $("#trace-events").innerHTML = stages.slice(0, visible).map((stage, index) => `
      <div class="trace-event ${stage[2] ? "rai" : ""} ${index === visible - 1 ? "running" : ""}">
        ${stage[2] ? '<span class="rai-label">Responsible AI control</span>' : ""}
        <strong>${stage[0]}</strong>
        <span>${stage[1]}</span>
        <small>${index === visible - 1 ? "Running" : "Completed"}</small>
      </div>`).join("");
    if (visible < stages.length) visible += 1;
  };
  draw();
  return setInterval(draw, 1100);
}

async function openAssessment(id) {
  state.current = await api(`/api/assessments/${id}`);
  renderAssessment(state.current);
  renderTrace(state.current.execution_trace || []);
  showView("result");
}

async function loadModules() {
  const list = $("#module-list");
  try {
    state.modules = await api("/api/modules");
    $("#module-count").textContent = state.modules.length;
    const gradeFilter = $("#module-grade-filter");
    const subjectFilter = $("#module-subject-filter");
    const selectedGrade = gradeFilter.value;
    const selectedSubject = subjectFilter.value;
    const grades = [...new Set(state.modules.map((module) => module.grade_level))].sort();
    const subjects = [...new Set(state.modules.map((module) => module.subject))].sort();
    gradeFilter.innerHTML = '<option value="">All classes</option>' +
      grades.map((grade) => `<option value="${escapeHtml(grade)}">${escapeHtml(grade)}</option>`).join("");
    subjectFilter.innerHTML = '<option value="">All subjects</option>' +
      subjects.map((subject) => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`).join("");
    gradeFilter.value = selectedGrade;
    subjectFilter.value = selectedSubject;
    const teacherSelect = $("#teacher-module-select");
    const selectedTeacherModule = teacherSelect.value;
    teacherSelect.innerHTML = '<option value="">Select a module</option>' +
      state.modules.map((module) =>
        `<option value="${module.id}">${escapeHtml(module.grade_level)} · ${escapeHtml(module.subject)} · ${escapeHtml(module.title)}</option>`
      ).join("");
    teacherSelect.value = selectedTeacherModule;
    renderModuleLibrary();
  } catch (error) {
    list.innerHTML = `<div class="error-message">${escapeHtml(error.message)}</div>`;
  }
}

async function loadHomeworks() {
  const select = $("#homework-select");
  try {
    state.homeworks = await api("/api/homeworks");
    $("#student-task-count").textContent = state.homeworks.length;
    select.innerHTML = '<option value="">Select homework</option>' +
      state.homeworks.map((homework) =>
        `<option value="${homework.id}">${escapeHtml(homework.grade_level)} · ${escapeHtml(homework.subject)} · ${escapeHtml(homework.title)}</option>`
      ).join("");
  } catch (error) {
    $("#form-error").textContent = error.message;
  }
}

function selectedHomework() {
  return state.homeworks.find((item) => item.id === $("#homework-select").value);
}

function renderHomeworkBrief() {
  const homework = selectedHomework();
  const brief = $("#homework-brief");
  if (!homework) {
    brief.className = "homework-brief empty";
    brief.textContent = "Select an assigned homework to view its instructions and rubric.";
    return;
  }
  brief.className = "homework-brief";
  brief.innerHTML = `
    <span class="eyebrow">${escapeHtml(homework.grade_level)} · ${escapeHtml(homework.subject)} · ${escapeHtml(homework.due_label)}</span>
    <h3>${escapeHtml(homework.title)}</h3>
    <p>${escapeHtml(homework.instructions)}</p>
    <div class="homework-meta">
      ${homework.allowed_submission_types.map((type) =>
        `<span>${escapeHtml(type.replaceAll("_", " "))}</span>`
      ).join("")}
    </div>
    <div class="homework-rubric">
      ${homework.rubric.map((item) =>
        `<div>${escapeHtml(item.name)} <strong>${item.max_points} pts</strong></div>`
      ).join("")}
    </div>
  `;
}

function renderMcq(homework) {
  $("#mcq-panel").innerHTML = homework.mcq_questions.map((question, index) => `
    <div class="mcq-question">
      <strong>${index + 1}. ${escapeHtml(question.prompt)}</strong>
      <div class="mcq-options">
        ${question.options.map((option, optionIndex) => `
          <label>
            <input type="radio" name="mcq-${question.id}" value="${optionIndex}">
            <span>${escapeHtml(option)}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function configureSubmissionMode() {
  const homework = selectedHomework();
  const type = $("#submission-type").value;
  const filePanel = $("#submission-file-panel");
  const fileInput = $("#submission-file");
  const help = $("#submission-file-help");
  $("#mcq-panel").classList.add("hidden");
  $("#external-processing-panel").classList.add("hidden");
  filePanel.classList.add("hidden");
  fileInput.value = "";

  if (!homework || !type) return;
  if (!homework.allowed_submission_types.includes(type)) {
    $("#form-error").textContent = "This format is not available for the selected homework.";
    $("#submission-type").value = "";
    return;
  }
  if (type === "mcq") {
    renderMcq(homework);
    $("#mcq-panel").classList.remove("hidden");
  } else {
    filePanel.classList.remove("hidden");
    if (type === "handwritten_image") {
      fileInput.accept = "image/jpeg,image/png,image/webp";
      help.textContent = "Upload a clear JPG, PNG, or WEBP photo of the handwritten pages.";
    } else if (type === "handwritten_pdf") {
      fileInput.accept = "application/pdf,.pdf";
      help.textContent = "Upload a PDF containing clear scans or photos of the handwritten pages.";
    } else {
      fileInput.accept = "video/*";
      help.textContent = "Upload the recorded homework video. It remains outside the grading model.";
      $("#external-processing-panel").classList.remove("hidden");
    }
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The homework file could not be read."));
    reader.readAsDataURL(file);
  });
}

function renderModuleLibrary() {
  const query = $("#module-search").value.trim().toLowerCase();
  const grade = $("#module-grade-filter").value;
  const subject = $("#module-subject-filter").value;
  const filtered = state.modules.filter((module) => {
    const matchesQuery = !query ||
      `${module.title} ${module.subject} ${module.grade_level}`.toLowerCase().includes(query);
    return matchesQuery &&
      (!grade || module.grade_level === grade) &&
      (!subject || module.subject === subject);
  });
  $("#module-results-count").textContent =
    `${filtered.length} of ${state.modules.length} modules`;
  $("#module-list").innerHTML = filtered.length
    ? filtered.map((module) => `
        <div class="module-item">
          <strong>${escapeHtml(module.title)}</strong>
          <div class="module-actions">
            <span>${escapeHtml(module.subject)} · ${escapeHtml(module.grade_level)} · ${module.evaluation_rubric.length} evaluation parameters</span>
            <button class="secondary-button edit-module-rubric" type="button" data-module-id="${module.id}">Edit rubric</button>
          </div>
        </div>`).join("")
    : '<div class="empty-state"><p>No modules match these filters.</p></div>';
  document.querySelectorAll(".edit-module-rubric").forEach((button) => {
    button.addEventListener("click", () => openRubricEditor(button.dataset.moduleId));
  });
}

function addRubricEditorRow(criterion = { name: "", description: "", max_points: 10 }) {
  const row = document.createElement("div");
  row.className = "criterion-row";
  row.innerHTML = `
    <label>Parameter<input class="rubric-name" required maxlength="120" value="${escapeHtml(criterion.name)}"></label>
    <label>Evaluation guidance<input class="rubric-description" required maxlength="500" value="${escapeHtml(criterion.description)}"></label>
    <label>Points<input class="rubric-points" type="number" min="1" max="100" step="1" required value="${criterion.max_points}"></label>
    <button type="button" class="remove-rubric-criterion" aria-label="Remove parameter">×</button>
  `;
  row.querySelector(".rubric-points").addEventListener("input", updateRubricTotal);
  row.querySelector(".remove-rubric-criterion").addEventListener("click", () => {
    if ($("#rubric-editor-list").children.length > 1) row.remove();
    updateRubricTotal();
  });
  $("#rubric-editor-list").appendChild(row);
  updateRubricTotal();
}

function updateRubricTotal() {
  const total = [...document.querySelectorAll(".rubric-points")]
    .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  $("#rubric-total").textContent = total;
}

function openRubricEditor(moduleId) {
  const module = state.modules.find((item) => item.id === moduleId);
  if (!module) return;
  state.rubricModuleId = moduleId;
  $("#rubric-module-context").textContent =
    `${module.grade_level} · ${module.subject} · ${module.title}`;
  $("#rubric-editor-list").innerHTML = "";
  module.evaluation_rubric.forEach(addRubricEditorRow);
  $("#rubric-editor-error").textContent = "";
  $("#rubric-overlay").classList.remove("hidden");
}

function getStoredStudent() {
  const stored = localStorage.getItem("edugrade_student");
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    localStorage.removeItem("edugrade_student");
    return null;
  }
}

function updateConsentStatus() {
  const badge = $("#consent-status");
  if (!state.student) {
    badge.textContent = "First login required";
    badge.className = "status-badge needs_review";
    $("#consent-reference-display").textContent = "";
    return;
  }
  badge.textContent = state.student.video_processing_approved
    ? "Parent consent verified · video approved"
    : "Parent consent verified · video disabled";
  badge.className = "status-badge ready_for_approval";
  $("#consent-reference-display").textContent =
    `Consent record: ${state.student.consent_reference} · Version ${state.student.consent_version}`;
}

function requireStudentRegistration() {
  state.student = getStoredStudent();
  updateConsentStatus();
  if (!state.student) $("#registration-overlay").classList.remove("hidden");
}

async function sendVerification(kind) {
  const isStudent = kind === "student";
  const emailInput = isStudent ? $("#register-student-email") : $("#parent-email");
  const status = isStudent
    ? $("#student-verification-status")
    : $("#parent-verification-status");
  const message = $("#demo-code-message");
  if (!emailInput.reportValidity()) return;
  try {
    const challenge = await api("/api/verifications/request", {
      method: "POST",
      body: JSON.stringify({
        email: emailInput.value.trim(),
        purpose: isStudent ? "student_email" : "parent_email",
      }),
    });
    state.verification[kind] = { requestId: challenge.request_id, token: null };
    status.textContent = "Code sent";
    if (challenge.demo_code) {
      message.textContent = `Demo email delivery: verification code ${challenge.demo_code} was sent to ${emailInput.value.trim()}.`;
      message.classList.remove("hidden");
      const codeInput = isStudent
        ? $("#student-verification-code")
        : $("#parent-verification-code");
      codeInput.value = challenge.demo_code;
    }
  } catch (error) {
    $("#registration-error").textContent = error.message;
  }
}

async function confirmVerification(kind) {
  const isStudent = kind === "student";
  const codeInput = isStudent
    ? $("#student-verification-code")
    : $("#parent-verification-code");
  const status = isStudent
    ? $("#student-verification-status")
    : $("#parent-verification-status");
  const row = document.querySelector(`[data-verification="${kind}"]`);
  const requestId = state.verification[kind].requestId;
  if (!requestId) {
    $("#registration-error").textContent = "Send a verification code first.";
    return;
  }
  try {
    const result = await api("/api/verifications/confirm", {
      method: "POST",
      body: JSON.stringify({
        request_id: requestId,
        code: codeInput.value.trim(),
      }),
    });
    state.verification[kind].token = result.verification_token;
    status.textContent = "Email verified ✓";
    row.classList.add("verified");
    codeInput.disabled = true;
  } catch (error) {
    $("#registration-error").textContent = error.message;
  }
}

function renderAssessment(item) {
  const result = item.result;
  const reviewLocked = ["approved", "overridden"].includes(item.status);
  $("#result-content").innerHTML = `
    <div class="result-grid">
      <section class="result-panel">
        <div class="result-summary">
          <div>
            <span class="status-badge ${item.status}">${item.status.replaceAll("_", " ")}</span>
            <h2>${escapeHtml(item.input.student_name)}</h2>
            <p>${escapeHtml(item.input.assignment_title)}</p>
            <p>${escapeHtml(result.module_alignment || "Module alignment evaluated.")}</p>
          </div>
          <div class="score-ring" style="--score:${result.percentage}%">
            <div><strong>${result.percentage.toFixed(0)}%</strong><span>${result.total_score}/${result.max_score} pts</span></div>
          </div>
        </div>
        <div>
          ${result.criterion_evaluations.map((criterion) => `
            <div class="criterion-result">
              <div class="criterion-title">
                <strong>${escapeHtml(criterion.criterion)}</strong>
                <b>${criterion.score}/${criterion.max_points}</b>
              </div>
              <p>${escapeHtml(criterion.rationale)}</p>
              ${criterion.evidence.length ? `<div class="evidence">Evidence: ${escapeHtml(criterion.evidence.join(" · "))}</div>` : ""}
            </div>
          `).join("")}
        </div>
        <div class="insight-columns">
          <div class="insight-box"><h3>Strengths</h3><ul>${listItems(result.strengths)}</ul></div>
          <div class="insight-box"><h3>Learning gaps</h3><ul>${listItems(result.learning_gaps)}</ul></div>
          <div class="insight-box"><h3>Recommended next steps</h3><ul>${listItems(result.recommendations)}</ul></div>
          <div class="insight-box"><h3>Assignment prompt</h3><p>${escapeHtml(item.input.assignment_prompt)}</p></div>
        </div>
        <div class="feedback-compare">
          <div class="insight-box">
            <span class="eyebrow">AI feedback · English</span>
            <p>${escapeHtml(result.personalized_feedback)}</p>
          </div>
          <div class="insight-box">
            <span class="eyebrow">AI feedback · Hindi</span>
            <p>${escapeHtml(result.personalized_feedback_hi || "Hindi feedback was not returned.")}</p>
          </div>
        </div>
      </section>
      <aside>
        <div class="confidence-card">
          <span class="eyebrow">AI confidence</span>
          <div class="confidence-value">${(result.confidence.score * 100).toFixed(0)}%</div>
          <p>${escapeHtml(result.confidence.rationale)}</p>
          ${result.confidence.uncertainty_factors.length
            ? `<strong>Uncertainty factors</strong><ul>${listItems(result.confidence.uncertainty_factors)}</ul>`
            : "<p>No material uncertainty factors identified.</p>"}
        </div>
        <div class="result-panel review-form">
          <span class="eyebrow">Educator decision</span>
          <h3>${reviewLocked ? "Review complete" : "Review and release"}</h3>
          <div class="ai-decision">
            <label><input type="radio" name="ai-feedback-decision" value="accept" ${item.ai_feedback_accepted !== false ? "checked" : ""} ${reviewLocked ? "disabled" : ""}> Accept AI feedback</label>
            <label><input type="radio" name="ai-feedback-decision" value="discard" ${item.ai_feedback_accepted === false ? "checked" : ""} ${reviewLocked ? "disabled" : ""}> Discard AI feedback</label>
          </div>
          <label>Final score
            <input id="review-score" type="number" min="0" max="${result.max_score}" step="0.5" value="${result.total_score}" ${reviewLocked ? "disabled" : ""}>
          </label>
          <label>Teacher feedback · English
            <textarea id="teacher-feedback" rows="5" placeholder="Add personalized teacher guidance..." ${reviewLocked ? "disabled" : ""}>${escapeHtml(item.teacher_feedback || "")}</textarea>
          </label>
          <label>Teacher feedback · Hindi
            <textarea id="teacher-feedback-hi" rows="5" placeholder="शिक्षक की व्यक्तिगत प्रतिक्रिया..." ${reviewLocked ? "disabled" : ""}>${escapeHtml(item.teacher_feedback_hi || "")}</textarea>
          </label>
          <label>Reviewer
            <input id="reviewer" value="Demo Instructor" ${reviewLocked ? "disabled" : ""}>
          </label>
          <label>Review notes
            <textarea id="review-notes" rows="3" placeholder="Optional governance note" ${reviewLocked ? "disabled" : ""}></textarea>
          </label>
          ${reviewLocked ? "" : `
            <div class="action-grid">
              <button class="secondary-button review-action" data-action="edit">Save edits</button>
              <button class="primary-button review-action" data-action="approve"><span>Approve</span><span>✓</span></button>
              <button class="danger-button review-action" data-action="override">Override AI grade</button>
            </div>
          `}
          <div id="review-error" class="error-message"></div>
        </div>
        <div class="result-panel">
          <span class="eyebrow">Audit trail</span>
          <ul class="audit-list">
            ${item.audit_trail.map((event) => `
              <li><strong>${escapeHtml(event.actor)} · ${escapeHtml(event.action)}</strong>
              ${escapeHtml(event.details)}<br>${new Date(event.timestamp).toLocaleString()}</li>
            `).join("")}
          </ul>
        </div>
      </aside>
    </div>
  `;
  document.querySelectorAll(".review-action").forEach((button) => {
    button.addEventListener("click", () => submitReview(button.dataset.action));
  });
}

async function submitReview(action) {
  const errorBox = $("#review-error");
  errorBox.textContent = "";
  try {
    const payload = {
      action,
      reviewer: $("#reviewer").value.trim(),
      notes: $("#review-notes").value.trim(),
      total_score: Number($("#review-score").value),
      ai_feedback_decision: document.querySelector('input[name="ai-feedback-decision"]:checked').value,
      teacher_feedback: $("#teacher-feedback").value.trim(),
      teacher_feedback_hi: $("#teacher-feedback-hi").value.trim(),
    };
    state.current = await api(`/api/assessments/${state.current.id}/review`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderAssessment(state.current);
    renderTrace(state.current.execution_trace || [], "Teacher review completed");
    await loadQueue();
  } catch (error) {
    errorBox.textContent = error.message;
  }
}

$("#assessment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = $("#form-error");
  const button = $("#evaluate-button");
  errorBox.textContent = "";
  button.disabled = true;
  $("#loading-overlay").classList.remove("hidden");
  const traceTimer = startLiveTrace();
  try {
    const homework = selectedHomework();
    const submissionType = $("#submission-type").value;
    if (!homework) throw new Error("Select an assigned homework.");
    if (!submissionType) throw new Error("Select a submission format.");

    let attachment = null;
    let submission = "";
    const mcqAnswers = {};

    if (submissionType === "handwritten_image" || submissionType === "handwritten_pdf") {
      const file = $("#submission-file").files[0];
      if (!file) throw new Error("Upload the handwritten homework file.");
      if (file.size > 10_000_000) throw new Error("The homework file must be 10 MB or smaller.");
      attachment = {
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        data_url: await fileToDataUrl(file),
      };
    } else if (submissionType === "mcq") {
      for (const question of homework.mcq_questions) {
        const selected = document.querySelector(`input[name="mcq-${question.id}"]:checked`);
        if (!selected) throw new Error("Answer every MCQ before submitting.");
        mcqAnswers[question.id] = Number(selected.value);
      }
    } else if (submissionType === "video_and_handnote") {
      const video = state.recordedVideo || $("#submission-file").files[0];
      const transcript = $("#video-transcript-file").files[0];
      if (!video) throw new Error("Upload the recorded homework video.");
      if (!transcript) {
        throw new Error("Upload the transcript generated by the external media service.");
      }
      submission = await transcript.text();
      if (!submission.trim()) throw new Error("The external transcript is empty.");
    }

    const payload = {
      homework_id: homework.id,
      student_name: state.student?.student_name || "Registered student",
      student_id: state.student?.id || "",
      assignment_title: homework.title,
      assignment_prompt: homework.instructions,
      submission_type: submissionType,
      permission_confirmed: $("#permission-confirmed").checked,
      external_media_processing_confirmed: $("#external-processing-confirmed").checked,
      media_processing_reference: $("#media-processing-reference").value.trim(),
      submission,
      attachment,
      mcq_answers: mcqAnswers,
      rubric: homework.rubric,
    };
    const assessment = await api("/api/assessments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadQueue();
    state.current = assessment;
    renderAssessment(assessment);
    renderTrace(assessment.execution_trace || []);
    showView("result");
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    clearInterval(traceTimer);
    button.disabled = false;
    $("#loading-overlay").classList.add("hidden");
  }
});

$("#refresh-queue").addEventListener("click", loadQueue);
$("#back-to-queue").addEventListener("click", () => showView("teacher"));
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.dataset.view === "teacher") {
      await loadQueue();
      await loadModules();
    }
    if (button.dataset.view === "admin") await loadModules();
    if (button.dataset.view === "student") {
      requireStudentRegistration();
      await loadHomeworks();
    }
    showView(button.dataset.view);
  });
});

$("#module-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = $("#module-error");
  errorBox.textContent = "";
  try {
    await api("/api/modules", {
      method: "POST",
      body: JSON.stringify({
        title: $("#module-title").value.trim(),
        subject: $("#module-subject").value.trim(),
        grade_level: $("#module-grade").value.trim(),
        source_type: $("#module-source").value,
        content: $("#module-content").value.trim(),
      }),
    });
    event.target.reset();
    await loadModules();
  } catch (error) {
    errorBox.textContent = error.message;
  }
});

$("#module-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!/\.(txt|md)$/i.test(file.name)) {
    $("#module-error").textContent = "For this MVP, paste PDF/DOC content into the module field. TXT and MD files can be read directly.";
    return;
  }
  $("#module-content").value = await file.text();
  if (!$("#module-title").value) $("#module-title").value = file.name.replace(/\.[^.]+$/, "");
});

$("#module-search").addEventListener("input", renderModuleLibrary);
$("#module-grade-filter").addEventListener("change", renderModuleLibrary);
$("#module-subject-filter").addEventListener("change", renderModuleLibrary);
$("#teacher-edit-rubric").addEventListener("click", () => {
  const moduleId = $("#teacher-module-select").value;
  if (moduleId) openRubricEditor(moduleId);
});
$("#close-rubric-editor").addEventListener("click", () => {
  $("#rubric-overlay").classList.add("hidden");
});
$("#add-rubric-criterion").addEventListener("click", () => {
  if ($("#rubric-editor-list").children.length < 8) addRubricEditorRow();
});
$("#rubric-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = $("#rubric-editor-error");
  errorBox.textContent = "";
  const rubric = [...document.querySelectorAll("#rubric-editor-list .criterion-row")]
    .map((row) => ({
      name: row.querySelector(".rubric-name").value.trim(),
      description: row.querySelector(".rubric-description").value.trim(),
      max_points: Number(row.querySelector(".rubric-points").value),
    }));
  const total = rubric.reduce((sum, item) => sum + item.max_points, 0);
  if (Math.abs(total - 100) > 0.01) {
    errorBox.textContent = "Evaluation parameters must total exactly 100 points.";
    return;
  }
  try {
    await api(`/api/modules/${state.rubricModuleId}/rubric`, {
      method: "PUT",
      body: JSON.stringify({ rubric }),
    });
    await loadModules();
    await loadHomeworks();
    $("#rubric-overlay").classList.add("hidden");
  } catch (error) {
    errorBox.textContent = error.message;
  }
});

$("#homework-select").addEventListener("change", () => {
  renderHomeworkBrief();
  configureSubmissionMode();
});

$("#submission-type").addEventListener("change", (event) => {
  configureSubmissionMode();
  const isVideo = event.target.value === "video_and_handnote";
  if (!isVideo) return;
  if (!state.student) {
    $("#registration-overlay").classList.remove("hidden");
    event.target.value = "";
    $("#external-processing-panel").classList.add("hidden");
    return;
  }
  if (!state.student.video_processing_approved) {
    $("#form-error").textContent = "Video upload is disabled because it was not approved during parent consent registration.";
    event.target.value = "";
    $("#external-processing-panel").classList.add("hidden");
  }
});

$("#start-recording").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const chunks = [];
    state.recordingStream = stream;
    state.mediaRecorder = new MediaRecorder(stream);
    $("#video-preview").srcObject = stream;
    await $("#video-preview").play();
    state.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    state.mediaRecorder.addEventListener("stop", () => {
      const blob = new Blob(chunks, { type: state.mediaRecorder.mimeType || "video/webm" });
      state.recordedVideo = new File([blob], "recorded-homework.webm", { type: blob.type });
      $("#video-preview").srcObject = null;
      $("#video-preview").src = URL.createObjectURL(blob);
      $("#video-preview").controls = true;
      $("#recording-status").textContent = "Recording ready for external processing.";
      state.recordingStream.getTracks().forEach((track) => track.stop());
      state.recordingStream = null;
    });
    state.mediaRecorder.start();
    $("#start-recording").disabled = true;
    $("#stop-recording").disabled = false;
    $("#recording-status").textContent = "Recording in progress...";
  } catch (error) {
    $("#form-error").textContent = `Camera or microphone access failed: ${error.message}`;
  }
});

$("#stop-recording").addEventListener("click", () => {
  if (state.mediaRecorder?.state === "recording") state.mediaRecorder.stop();
  $("#start-recording").disabled = false;
  $("#stop-recording").disabled = true;
});

$("#registration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = $("#registration-error");
  errorBox.textContent = "";
  if (!state.verification.student.token || !state.verification.parent.token) {
    errorBox.textContent = "Verify both student and parent email addresses before registration.";
    return;
  }
  try {
    const profile = await api("/api/students/register", {
      method: "POST",
      body: JSON.stringify({
        student_name: $("#register-student-name").value.trim(),
        student_email: $("#register-student-email").value.trim(),
        parent_name: $("#parent-name").value.trim(),
        parent_email: $("#parent-email").value.trim(),
        parent_consent_confirmed: $("#registration-parent-consent").checked,
        video_processing_approved: $("#registration-video-consent").checked,
        student_email_verification_token: state.verification.student.token,
        parent_email_verification_token: state.verification.parent.token,
      }),
    });
    localStorage.setItem("edugrade_student", JSON.stringify(profile));
    state.student = profile;
    updateConsentStatus();
    $("#registration-overlay").classList.add("hidden");
  } catch (error) {
    errorBox.textContent = error.message;
  }
});

$("#send-student-code").addEventListener("click", () => sendVerification("student"));
$("#verify-student-code").addEventListener("click", () => confirmVerification("student"));
$("#send-parent-code").addEventListener("click", () => sendVerification("parent"));
$("#verify-parent-code").addEventListener("click", () => confirmVerification("parent"));

$("#register-student-email").addEventListener("input", () => {
  state.verification.student = { requestId: null, token: null };
  $("#student-verification-status").textContent = "Not verified";
  document.querySelector('[data-verification="student"]').classList.remove("verified");
  $("#student-verification-code").disabled = false;
});
$("#parent-email").addEventListener("input", () => {
  state.verification.parent = { requestId: null, token: null };
  $("#parent-verification-status").textContent = "Not verified";
  document.querySelector('[data-verification="parent"]').classList.remove("verified");
  $("#parent-verification-code").disabled = false;
});

$("#trace-toggle").addEventListener("click", () => {
  $("#trace-panel").classList.toggle("collapsed");
  document.body.classList.toggle(
    "trace-open",
    !$("#trace-panel").classList.contains("collapsed")
  );
});
$("#trace-collapse").addEventListener("click", () => {
  $("#trace-panel").classList.add("collapsed");
  document.body.classList.remove("trace-open");
});

checkHealth();
loadQueue();
loadModules();
loadHomeworks();
state.student = getStoredStudent();
updateConsentStatus();
