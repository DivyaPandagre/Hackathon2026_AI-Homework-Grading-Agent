const state = {
  assessments: [],
  current: null,
  modules: [],
  student: null,
};

const $ = (selector) => document.querySelector(selector);
const rubricList = $("#rubric-list");

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addCriterion(name = "", description = "", points = 10) {
  const row = document.createElement("div");
  row.className = "criterion-row";
  row.innerHTML = `
    <label>Criterion<input class="criterion-name" required value="${escapeHtml(name)}" placeholder="e.g. Accuracy"></label>
    <label>Description<input class="criterion-description" required value="${escapeHtml(description)}" placeholder="What does success look like?"></label>
    <label>Points<input class="criterion-points" type="number" min="1" max="1000" step="0.5" required value="${points}"></label>
    <button type="button" class="remove-criterion" aria-label="Remove criterion">×</button>
  `;
  row.querySelector(".remove-criterion").addEventListener("click", () => {
    if (rubricList.children.length > 1) row.remove();
    updateTotal();
  });
  row.querySelector(".criterion-points").addEventListener("input", updateTotal);
  rubricList.appendChild(row);
  updateTotal();
}

function updateTotal() {
  const total = [...document.querySelectorAll(".criterion-points")]
    .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  $("#total-points").textContent = total;
}

function collectRubric() {
  return [...document.querySelectorAll(".criterion-row")].map((row) => ({
    name: row.querySelector(".criterion-name").value.trim(),
    description: row.querySelector(".criterion-description").value.trim(),
    max_points: Number(row.querySelector(".criterion-points").value),
  }));
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
  const select = $("#module-select");
  try {
    state.modules = await api("/api/modules");
    $("#module-count").textContent = state.modules.length;
    select.innerHTML = '<option value="">Select an admin module</option>' +
      state.modules.map((module) =>
        `<option value="${module.id}">${escapeHtml(module.title)} · ${escapeHtml(module.grade_level)}</option>`
      ).join("");
    list.innerHTML = state.modules.length
      ? state.modules.map((module) => `
          <div class="module-item">
            <strong>${escapeHtml(module.title)}</strong>
            <span>${escapeHtml(module.subject)} · ${escapeHtml(module.grade_level)} · ${escapeHtml(module.source_type.replaceAll("_", " "))}</span>
          </div>`).join("")
      : '<div class="empty-state"><p>No modules uploaded yet.</p></div>';
  } catch (error) {
    list.innerHTML = `<div class="error-message">${escapeHtml(error.message)}</div>`;
  }
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
    return;
  }
  badge.textContent = state.student.video_processing_approved
    ? "Parent consent verified · video approved"
    : "Parent consent verified · video disabled";
  badge.className = "status-badge ready_for_approval";
  $("#student-name").value = state.student.student_name;
}

function requireStudentRegistration() {
  state.student = getStoredStudent();
  updateConsentStatus();
  if (!state.student) $("#registration-overlay").classList.remove("hidden");
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
    const payload = {
      student_name: $("#student-name").value.trim(),
      student_id: state.student?.id || "",
      assignment_title: $("#assignment-title").value.trim(),
      assignment_prompt: $("#assignment-prompt").value.trim(),
      module_title: state.modules.find((item) => item.id === $("#module-select").value)?.title || "Teacher-provided learning module",
      module_content: state.modules.find((item) => item.id === $("#module-select").value)?.content || "",
      submission_type: $("#submission-type").value,
      permission_confirmed: $("#permission-confirmed").checked,
      external_media_processing_confirmed: $("#external-processing-confirmed").checked,
      media_processing_reference: $("#media-processing-reference").value.trim(),
      submission: $("#submission").value.trim(),
      rubric: collectRubric(),
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

$("#load-sample").addEventListener("click", () => {
  $("#student-name").value = "Maya Johnson";
  $("#assignment-title").value = "Explaining the Water Cycle";
  $("#assignment-prompt").value = "Explain the four major stages of the water cycle, describe how solar energy drives the cycle, and give one example of how human activity can affect it.";
  if (state.modules.length) $("#module-select").value = state.modules[0].id;
  $("#submission").value = "The water cycle moves water around Earth. Evaporation happens when the sun heats oceans and turns liquid water into vapor. Condensation happens when the vapor cools and forms clouds. Precipitation is when water falls as rain or snow. Collection happens when water gathers in rivers, lakes, oceans, and underground. The sun provides the energy for evaporation, so without it the cycle would slow down. Human activities such as cutting down forests can reduce transpiration and change how much water returns to the atmosphere.";
  rubricList.innerHTML = "";
  addCriterion("Scientific accuracy", "Correctly explains the four stages and uses accurate terminology.", 40);
  addCriterion("Energy connection", "Explains how solar energy drives evaporation and the overall cycle.", 25);
  addCriterion("Human impact", "Provides and explains one relevant human impact.", 20);
  addCriterion("Clarity and completeness", "Response is organized, clear, and addresses every part of the prompt.", 15);
  $("#submission").dispatchEvent(new Event("input"));
});

$("#submission").addEventListener("input", (event) => {
  const words = event.target.value.trim() ? event.target.value.trim().split(/\s+/).length : 0;
  $("#word-count").textContent = words;
});
$("#add-criterion").addEventListener("click", () => addCriterion());
$("#refresh-queue").addEventListener("click", loadQueue);
$("#back-to-queue").addEventListener("click", () => showView("teacher"));
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.dataset.view === "teacher") await loadQueue();
    if (button.dataset.view === "admin") await loadModules();
    if (button.dataset.view === "student") requireStudentRegistration();
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

$("#submission-type").addEventListener("change", (event) => {
  const isVideo = event.target.value === "video_and_handnote";
  $("#external-processing-panel").classList.toggle("hidden", !isVideo);
  if (!isVideo) return;
  if (!state.student) {
    $("#registration-overlay").classList.remove("hidden");
    event.target.value = "typed_text";
    $("#external-processing-panel").classList.add("hidden");
    return;
  }
  if (!state.student.video_processing_approved) {
    $("#form-error").textContent = "Video upload is disabled because it was not approved during parent consent registration.";
    event.target.value = "typed_text";
    $("#external-processing-panel").classList.add("hidden");
  }
});

$("#registration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = $("#registration-error");
  errorBox.textContent = "";
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
        consent_reference: $("#registration-consent-reference").value.trim(),
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

addCriterion("Accuracy", "The response is factually correct and addresses the prompt.", 40);
addCriterion("Reasoning", "The response explains ideas with clear reasoning and relevant evidence.", 35);
addCriterion("Clarity", "The response is organized, complete, and easy to understand.", 25);
checkHealth();
loadQueue();
loadModules();
state.student = getStoredStudent();
updateConsentStatus();
