const state = {
  assessments: [],
  current: null,
  modules: [],
  homeworks: [],
  students: [],
  student: null,
  session: null,
  recordedVideo: null,
  mediaRecorder: null,
  recordingStream: null,
  rubricModuleId: null,
  agentRuns: loadStoredAgentRuns(),
  agentTraceActive: false,
  activeTraceIndex: 0,
  submissionConfirmed: false,
  verification: {
    student: { requestId: null, token: null },
    parent: { requestId: null, token: null },
  },
};

document.body.classList.toggle(
  "demo-mode",
  new URLSearchParams(window.location.search).get("demo") === "1"
);

const $ = (selector) => document.querySelector(selector);
const assessmentChannel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel("edugrade-assessment-updates")
  : null;
let appStatusTimer = null;

function announceAppStatus(message, type = "success") {
  const status = $("#app-status");
  if (!status) return;
  clearTimeout(appStatusTimer);
  status.textContent = message;
  status.className = `app-status ${type}`;
  appStatusTimer = setTimeout(() => status.classList.add("hidden"), 5000);
}

const VIEW_ROLES = {
  home: [],
  admin: ["admin"],
  teacher: ["teacher", "admin"],
  student: ["student"],
  result: ["teacher", "admin"],
};

function hasRole(...roles) {
  if (state.session?.is_local_demo) return true;
  return roles.some((role) => state.session?.roles?.includes(role));
}

function canAccessView(name) {
  const roles = VIEW_ROLES[name];
  return Array.isArray(roles) && (roles.length === 0 || hasRole(...roles));
}

function applyRoleNavigation() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("hidden", !canAccessView(button.dataset.view));
  });
  document.querySelectorAll(".home-view-button").forEach((button) => {
    button.classList.toggle("hidden", !canAccessView(button.dataset.openView));
  });
  const inspectorAllowed = hasRole("owner", "admin");
  $("#trace-toggle").classList.toggle("hidden", !inspectorAllowed);
  if (!inspectorAllowed) {
    $("#trace-panel").classList.add("collapsed");
    document.body.classList.remove("trace-open");
  }
}

async function loadSession() {
  state.session = await api("/api/session");
  applyRoleNavigation();
}

async function loadOwnedStudentProfile() {
  if (!hasRole("student") || state.session?.is_local_demo) return;
  try {
    state.student = await api("/api/me/student-profile");
    localStorage.setItem("edugrade_student", JSON.stringify(state.student));
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

function notifyAssessmentChanged(action, assessmentId = "") {
  assessmentChannel?.postMessage({ action, assessmentId, timestamp: Date.now() });
}

const AGENT_STAGES = [
  ["Permission and consent", "Verifying stored permissions and submission policy.", true],
  ["Learning module context", "Loading the teacher-approved module and rubric.", false],
  ["Local media boundary", "Ensuring raw video remains local and outside the grading model.", true],
  ["Rubric assessment agent", "Evaluating permitted academic evidence against each criterion.", false],
  ["Responsible AI safety check", "Checking child-safe feedback and prohibited inferences.", true],
  ["Confidence governance", "Calculating uncertainty and teacher-review routing.", true],
];

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadStartedHomeworks() {
  try {
    const ids = JSON.parse(localStorage.getItem("edugrade_started_homeworks") || "[]");
    return new Set(Array.isArray(ids) ? ids : []);
  } catch (error) {
    console.warn("Started-assignment state could not be read.", error);
    return new Set();
  }
}

function saveStartedHomeworks(ids) {
  localStorage.setItem("edugrade_started_homeworks", JSON.stringify([...ids]));
}

function markSelectedHomeworkStarted() {
  const homework = selectedHomework();
  if (!homework || !state.student) return;
  const started = loadStartedHomeworks();
  started.add(homework.id);
  saveStartedHomeworks(started);
  renderStudentAssignments();
}

function clearStartedHomework(homeworkId) {
  const started = loadStartedHomeworks();
  started.delete(homeworkId);
  saveStartedHomeworks(started);
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
      message = Array.isArray(body.detail)
        ? body.detail.map((item) => `${item.loc?.join(".") || "request"}: ${item.msg}`).join("; ")
        : body.detail || message;
    } catch {}
    const error = new Error(String(message));
    error.status = response.status;
    error.path = path;
    throw error;
  }
  return response.json();
}

function loadStoredAgentRuns() {
  try {
    const runs = JSON.parse(localStorage.getItem("edugrade_agent_runs") || "[]");
    return Array.isArray(runs) ? runs.slice(0, 20) : [];
  } catch (error) {
    console.warn("Agent run history could not be read.", error);
    return [];
  }
}

function saveAgentRuns() {
  localStorage.setItem("edugrade_agent_runs", JSON.stringify(state.agentRuns.slice(0, 20)));
}

function assessmentRun(assessment) {
  const attentionStatuses = new Set([
    "knowledge_incomplete", "provisional_source", "awaiting_transcription",
    "wrong_assignment", "needs_teacher_scoring",
  ]);
  const outcome = attentionStatuses.has(assessment.status) ? "attention" : "completed";
  const sourceTrace = assessment.execution_trace || [];
  return {
    id: `assessment:${assessment.id}`,
    timestamp: assessment.created_at,
    outcome,
    status: assessment.status,
    title: assessment.input.assignment_title,
    module: assessment.input.module_title,
    rationale: assessmentRationaleData(assessment),
    trace: sourceTrace.map((event, index) => ({
      ...event,
      run_state: outcome === "attention" && index === sourceTrace.length - 1
        ? "attention"
        : "completed",
    })),
    error: "",
  };
}

function assessmentRationaleData(assessment) {
  const result = assessment.result;
  return {
    score: result.provisional
      ? `${result.total_score}/${result.assessed_points_possible || 0} assessed points`
      : `${result.total_score}/${result.max_score} · ${result.percentage.toFixed(0)}%`,
    provisional: result.provisional,
    alignment: result.module_alignment,
    safety: result.safety_check,
    confidenceScore: result.confidence.score,
    confidenceRationale: result.confidence.rationale,
    uncertaintyFactors: result.confidence.uncertainty_factors,
    reviewRouting: assessment.review_required
      ? "Mandatory teacher review"
      : ["approved", "overridden"].includes(assessment.status)
        ? "Educator reviewed and released"
        : "Teacher approval required before release",
    criteria: result.criterion_evaluations.map((criterion) => ({
      name: criterion.criterion,
      score: criterion.score,
      maxPoints: criterion.max_points,
      assessed: criterion.assessed,
      rationale: criterion.rationale,
      evidence: criterion.evidence,
      notAssessedReason: criterion.not_assessed_reason,
    })),
  };
}

function rationaleMarkup(rationale) {
  if (!rationale) {
    return '<div class="trace-empty">No auditable evaluation rationale is available for this run.</div>';
  }
  return `
    <div class="rationale-disclosure">
      <strong>Why this result</strong>
      <span>This shows evidence and concise decision rationale—not private model chain-of-thought.</span>
    </div>
    <div class="rationale-summary-grid">
      <div><span>Calculated result</span><strong>${escapeHtml(rationale.score)}</strong></div>
      <div><span>Review routing</span><strong>${escapeHtml(rationale.reviewRouting)}</strong></div>
    </div>
    <details class="rationale-details">
      <summary>
        <span>
          <strong>View detailed evaluation</strong>
          <small>Inspect every rubric decision, cited evidence, uncertainty, safety check, and review route.</small>
        </span>
      </summary>
      <div class="rationale-details-content">
        <div class="rationale-detail-note">
          This is the complete auditable assessment record available to educators. It explains the evidence and scoring rules used without exposing private model chain-of-thought.
        </div>
        <div class="rationale-section">
          <span class="rationale-label">Criterion decisions</span>
          ${rationale.criteria.map((criterion) => `
            <article class="rationale-criterion ${criterion.assessed ? "" : "not-assessed"}">
              <div>
                <strong>${escapeHtml(criterion.name)}</strong>
                <b>${criterion.assessed ? `${criterion.score}/${criterion.maxPoints}` : "Not assessed"}</b>
              </div>
              <p>${escapeHtml(criterion.assessed ? criterion.rationale : criterion.notAssessedReason || criterion.rationale)}</p>
              ${criterion.evidence?.length
                ? `<ul>${criterion.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
                : '<small>No model evidence was used for this criterion.</small>'}
            </article>
          `).join("")}
        </div>
        <div class="rationale-section rationale-governance">
          <span class="rationale-label">Confidence and governance</span>
          <div><strong>Confidence ${(rationale.confidenceScore * 100).toFixed(0)}%</strong><p>${escapeHtml(rationale.confidenceRationale)}</p></div>
          ${rationale.uncertaintyFactors?.length
            ? `<div><strong>Uncertainty factors</strong><ul>${rationale.uncertaintyFactors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
            : '<div><strong>Uncertainty factors</strong><p>None reported.</p></div>'}
          <div><strong>Module alignment</strong><p>${escapeHtml(rationale.alignment || "No separate alignment note.")}</p></div>
          <div><strong>Safety check</strong><p>${escapeHtml(rationale.safety)}</p></div>
          <div><strong>Final routing decision</strong><p>${escapeHtml(rationale.reviewRouting)}</p></div>
        </div>
      </div>
    </details>
  `;
  updateSubmissionJourney();
}

function syncAssessmentRunHistory() {
  const merged = new Map(state.agentRuns.map((run) => [run.id, run]));
  state.assessments.forEach((assessment) => {
    merged.set(`assessment:${assessment.id}`, assessmentRun(assessment));
  });
  state.agentRuns = [...merged.values()]
    .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp))
    .slice(0, 20);
  saveAgentRuns();
  renderAgentRunHistory();
  if (!state.agentTraceActive && state.agentRuns.length) showAgentRun(state.agentRuns[0].id);
}

function recordAgentError(error, context = {}) {
  const failedIndex = Math.min(state.activeTraceIndex, AGENT_STAGES.length - 1);
  const run = {
    id: `error:${Date.now()}`,
    timestamp: new Date().toISOString(),
    outcome: "error",
    status: error.status ? `HTTP ${error.status}` : "Client error",
    title: context.assignment || "Assessment submission",
    module: context.module || "",
    trace: AGENT_STAGES.map((stage, index) => ({
      label: stage[0],
      detail: stage[1],
      responsible_ai: stage[2],
      run_state: index < failedIndex ? "completed" : index === failedIndex ? "failed" : "skipped",
    })),
    error: error.message,
    request_path: error.path || "/api/assessments",
  };
  state.agentRuns = [run, ...state.agentRuns].slice(0, 20);
  saveAgentRuns();
  renderAgentRunHistory();
  showAgentRun(run.id);
}

function renderAgentRunHistory() {
  const container = $("#trace-history-list");
  if (!container) return;
  container.innerHTML = state.agentRuns.length
    ? state.agentRuns.map((run) => `
        <button type="button" class="trace-history-item ${run.outcome}" data-run-id="${escapeHtml(run.id)}">
          <span><strong>${escapeHtml(run.title)}</strong><small>${new Date(run.timestamp).toLocaleString()}</small></span>
          <b>${escapeHtml(run.status.replaceAll("_", " "))}</b>
        </button>
      `).join("")
    : '<div class="trace-history-empty">No agent runs recorded yet.</div>';
  container.querySelectorAll("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => {
      showAgentRun(button.dataset.runId);
      container.classList.add("hidden");
    });
  });
}

function showAgentRun(runId) {
  const run = state.agentRuns.find((item) => item.id === runId);
  if (!run) {
    $("#trace-live-status").className = "trace-live-status";
    $("#trace-live-status").textContent = "No previous run is available";
    $("#trace-events").innerHTML = '<div class="trace-empty">Submit homework to create the first agent run.</div>';
    $("#trace-rationale").innerHTML = '<div class="trace-empty">No evaluation rationale is available.</div>';
    return;
  }
  if (run.outcome === "error") {
    $("#trace-live-status").className = "trace-live-status failed";
    $("#trace-live-status").textContent = `Last run failed · ${new Date(run.timestamp).toLocaleString()}`;
    $("#trace-events").innerHTML = `
      <div class="trace-error-detail">
        <span class="trace-error-label">Troubleshooting error</span>
        <strong>${escapeHtml(run.status)} · ${escapeHtml(run.title)}</strong>
        ${run.module ? `<small>${escapeHtml(run.module)}</small>` : ""}
        <p>${escapeHtml(run.error)}</p>
        <code>${escapeHtml(run.request_path)}</code>
      </div>
      <div class="trace-error-stages">${traceMarkup(run.trace)}</div>`;
    $("#trace-rationale").innerHTML = '<div class="trace-empty">No scoring rationale was produced because the run failed.</div>';
    return;
  }
  renderTrace(
    run.trace,
    `Last run ${run.outcome === "completed" ? "successful" : "needs attention"} · ${new Date(run.timestamp).toLocaleString()}`,
    run.outcome === "completed" ? "success" : "attention"
  );
  $("#trace-rationale").innerHTML = rationaleMarkup(run.rationale);
}

function showView(name) {
  if (!canAccessView(name)) {
    name = "home";
    announceAppStatus("Your signed-in role does not have access to that workspace.", "error");
  }
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  $(`#${name}-view`).classList.add("active");
  const nav = document.querySelector(`[data-view="${name}"]`);
  if (nav) nav.classList.add("active");
  $("#student-side-nav").classList.toggle("hidden", name !== "student");
  const titles = {
    home: "How the agent works",
    admin: "Ground assessment in trusted knowledge.",
    teacher: "Review before release.",
    student: "Learn with timely feedback.",
    result: "Review the AI draft.",
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

async function loadQueue({ showLoading = true } = {}) {
  const container = $("#queue-list");
  if (showLoading) {
    container.innerHTML = '<div class="empty-state">Loading assessments...</div>';
  }
  try {
    state.assessments = await api("/api/assessments");
    notifyAssessmentChanged("submitted", assessment.id);
    syncAssessmentRunHistory();
    refreshTeacherSurfaces();
    renderStudentSubmissions();
    renderStudentFeedback();
    renderStudentAssignments();
    return true;
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return false;
  }
}

function listItems(items) {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function traceMarkup(events) {
  return events.length
    ? events.map((event) => {
        const runState = event.run_state || "completed";
        const stateLabel = {
          completed: "Completed successfully",
          running: "Running",
          failed: "Failed",
          skipped: "Not reached",
          pending: "Waiting",
          attention: "Needs attention",
        }[runState] || "Completed successfully";
        return `
          <div class="trace-event ${event.responsible_ai ? "rai" : ""} ${runState}">
            ${event.responsible_ai ? '<span class="rai-label">Responsible AI control</span>' : ""}
            <strong>${escapeHtml(event.label)}</strong>
            <span>${escapeHtml(event.detail)}</span>
            <small>${event.timestamp ? `${stateLabel} · ${new Date(event.timestamp).toLocaleTimeString()}` : stateLabel}</small>
          </div>`;
      }).join("")
    : '<div class="trace-empty">No execution trace is available.</div>';
}

function renderTrace(events, liveLabel = "Assessment run completed", outcome = "success") {
  $("#trace-live-status").className = `trace-live-status ${outcome}`;
  $("#trace-live-status").textContent = liveLabel;
  $("#trace-events").innerHTML = traceMarkup(events);
}

function startLiveTrace() {
  $("#trace-panel").classList.remove("collapsed");
  document.body.classList.add("trace-open");
  $("#trace-history-list").classList.add("hidden");
  state.agentTraceActive = true;
  state.activeTraceIndex = 0;
  $("#trace-live-status").className = "trace-live-status running";
  $("#trace-live-status").textContent = "Agent execution in progress";
  $("#trace-rationale").innerHTML = '<div class="trace-empty">Evaluation rationale will appear when the assessment response is validated.</div>';
  $("#live-inspector-rationale").classList.add("hidden");
  $("#close-live-inspector").classList.add("hidden");
  $(".live-inspector-summary .loader").classList.remove("hidden");
  let visible = 1;
  const draw = () => {
    const currentIndex = Math.min(visible - 1, AGENT_STAGES.length - 1);
    state.activeTraceIndex = currentIndex;
    const markup = AGENT_STAGES.map((stage, index) => `
      <div class="trace-event ${stage[2] ? "rai" : ""} ${index === currentIndex ? "running" : ""} ${index < currentIndex ? "completed" : ""} ${index > currentIndex ? "pending" : ""}">
        ${stage[2] ? '<span class="rai-label">Responsible AI control</span>' : ""}
        <strong>${stage[0]}</strong>
        <span>${stage[1]}</span>
        <small>${index < currentIndex ? "Completed" : index === currentIndex ? "Running" : "Waiting"}</small>
      </div>`).join("");
    $("#trace-events").innerHTML = markup;
    $("#live-inspector-events").innerHTML = markup;
    $("#live-inspector-status").textContent = `Step ${currentIndex + 1} of ${AGENT_STAGES.length} · ${AGENT_STAGES[currentIndex][0]}`;
    if (visible < AGENT_STAGES.length) visible += 1;
  };
  draw();
  return setInterval(draw, 1100);
}

async function openAssessment(id) {
  state.current = await api(`/api/assessments/${id}`);
  renderAssessment(state.current);
  renderTrace(state.current.execution_trace || []);
  $("#trace-rationale").innerHTML = rationaleMarkup(assessmentRationaleData(state.current));
  showView("result");
}

async function loadModules() {
  const list = $("#module-list");
  try {
    state.modules = await api("/api/modules");
    renderKnowledgeCoverage();
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
    populateTeacherClasses();
    populateRegistrationClasses();
    populateStudentTestingFilters();
    renderModuleLibrary();
    renderTeacherReconciliation();
  } catch (error) {
    list.innerHTML = `<div class="error-message">${escapeHtml(error.message)}</div>`;
  }
}

function renderKnowledgeCoverage() {
  const summarize = (key) => [...state.modules.reduce((counts, module) => {
    const value = module[key];
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) =>
    left.localeCompare(right, undefined, { numeric: true })
  );
  const classes = summarize("grade_level");
  const subjects = summarize("subject");
  const renderChips = (items) => items.map(([label, count]) => `
    <div class="coverage-chip">
      <span>${escapeHtml(label)}</span>
      <strong>${count}</strong>
    </div>
  `).join("");

  $("#module-count").textContent = state.modules.length;
  $("#class-count").textContent = classes.length;
  $("#subject-count").textContent = subjects.length;
  $("#class-coverage").innerHTML = renderChips(classes);
  $("#subject-coverage").innerHTML = renderChips(subjects);
}

async function loadHomeworks() {
  const select = $("#homework-select");
  try {
    state.homeworks = await api("/api/homeworks");
    select.innerHTML = '<option value="">Select homework</option>' +
      state.homeworks.map((homework) =>
        `<option value="${homework.id}">${escapeHtml(homework.grade_level)} · ${escapeHtml(homework.subject)} · ${escapeHtml(homework.title)}</option>`
      ).join("");
    populateStudentTestingFilters();
    renderStudentAssignments();
    renderSubmissionChoices();
    renderTeacherDashboard();
    renderTeacherReconciliation();
  } catch (error) {
    $("#form-error").textContent = error.message;
  }
}

function populateRegistrationClasses() {
  const select = $("#register-class");
  const selected = select.value;
  const classes = [...new Set(state.modules.map((module) => module.grade_level))].sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true })
  );
  select.innerHTML = '<option value="">Select a class</option>' +
    classes.map((grade) => `<option value="${escapeHtml(grade)}">${escapeHtml(grade)}</option>`).join("");
  if (classes.includes(selected)) select.value = selected;
}

function populateTeacherClasses() {
    const select = $("#teacher-class-select");
    const selected = select.value;
    const classes = [...new Set(state.modules.map((module) => module.grade_level))].sort(
      (left, right) => left.localeCompare(right, undefined, { numeric: true })
    );
    select.innerHTML = '<option value="">Select a class</option>' +
      classes.map((grade) => `<option value="${escapeHtml(grade)}">${escapeHtml(grade)}</option>`).join("");
    if (classes.includes(selected)) select.value = selected;
    populateTeacherSubjects();
}

function populateTeacherSubjects() {
    const grade = $("#teacher-class-select").value;
    const select = $("#teacher-subject-select");
    const selected = select.value;
    const subjects = [...new Set(
      state.modules
        .filter((module) => module.grade_level === grade)
        .map((module) => module.subject)
    )].sort();
    select.innerHTML = '<option value="">Select a subject</option>' +
      subjects.map((subject) => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`).join("");
    select.disabled = !grade;
    if (subjects.includes(selected)) {
      select.value = selected;
    } else if (subjects.length === 1) {
      select.value = subjects[0];
    }
    renderTeacherModules();
}

function renderTeacherModules() {
    const grade = $("#teacher-class-select").value;
    const subject = $("#teacher-subject-select").value;
    const selectedModuleId = $("#teacher-module-select").value;
    const container = $("#teacher-module-list");
    const modules = state.modules.filter(
      (module) => module.grade_level === grade && module.subject === subject
    );
    if (!grade) {
      container.innerHTML = '<div class="teacher-selection-empty">Select a class and subject to see its modules.</div>';
      $("#teacher-module-select").value = "";
      $("#teacher-module-context").textContent = "No class selected";
      $("#teacher-edit-rubric").disabled = true;
      renderTeacherDashboard();
      return;
    }
    if (!subject) {
      container.innerHTML = '<div class="teacher-selection-empty">Now select a subject to load its dashboard and modules.</div>';
      $("#teacher-module-select").value = "";
      $("#teacher-module-context").textContent = `${grade} · Select a subject`;
      $("#teacher-edit-rubric").disabled = true;
      renderTeacherDashboard();
      return;
    }
    const activeModules = modules.map((module) => {
      const assessments = pendingTeacherAssessments().filter(
        (assessment) => assessmentModuleId(assessment) === module.id
      );
      return { module, assessments };
    }).filter(({ assessments }) => assessments.length);
    container.innerHTML = activeModules.map(({ module, assessments }) => {
      const inReviewCount = assessments.filter(
        (assessment) => assessment.status === "ready_for_approval"
      ).length;
      const pendingCount = assessments.length - inReviewCount;
      const reviewLabels = [];
      if (pendingCount) {
        reviewLabels.push(`${pendingCount} pending review${pendingCount === 1 ? "" : "s"}`);
      }
      if (inReviewCount) {
        reviewLabels.push(`${inReviewCount} in review`);
      }
      return `
        <button type="button" class="teacher-module-card ${module.id === selectedModuleId ? "selected" : ""}" data-module-id="${module.id}">
          <span>${escapeHtml(module.subject)}</span>
          <strong>${escapeHtml(module.title)}</strong>
          <small>${module.evaluation_rubric.length} assessment parameters · ${escapeHtml(module.source_status)}</small>
          <em class="has-pending">${reviewLabels.join(" · ")}</em>
        </button>`;
    }).join("") || '<div class="teacher-selection-empty">No pending or in-review modules for this subject.</div>';
    if (!activeModules.some(({ module }) => module.id === selectedModuleId)) {
      $("#teacher-module-select").value = "";
      $("#teacher-module-context").textContent = `${grade} · ${subject} · All modules`;
      $("#teacher-edit-rubric").disabled = true;
    }
    document.querySelectorAll(".teacher-module-card").forEach((button) => {
      button.addEventListener("click", () => {
        $("#teacher-module-select").value =
          $("#teacher-module-select").value === button.dataset.moduleId ? "" : button.dataset.moduleId;
        renderTeacherModules();
        renderTeacherDashboard();
      });
    });
    const selectedModule = modules.find((module) => module.id === $("#teacher-module-select").value);
    if (selectedModule) {
      $("#teacher-module-context").textContent = `${selectedModule.subject} · ${selectedModule.title}`;
      $("#teacher-edit-rubric").disabled = false;
    }
    renderTeacherDashboard();
}

function assessmentModuleId(assessment) {
    const homework = state.homeworks.find((item) => item.id === assessment.input.homework_id);
    return homework?.module_id || "";
}

function assessmentRelationshipIssue(assessment) {
  if (!assessment.input.homework_id) return "Missing homework identifier";
  const homework = state.homeworks.find((item) => item.id === assessment.input.homework_id);
  if (!homework) return "Linked homework is unavailable";
  if (!state.modules.some((module) => module.id === homework.module_id)) {
    return "Linked learning module is unavailable";
  }
  if (assessment.input.student_id && state.students.length &&
      !state.students.some((student) => student.id === assessment.input.student_id)) {
    return "Registered learner record is unavailable";
  }
  return "";
}

function renderTeacherReconciliation() {
  const section = $("#teacher-reconciliation-section");
  const container = $("#teacher-reconciliation-list");
  if (!section || !container) return;
  const records = state.assessments
    .map((assessment) => ({ assessment, issue: assessmentRelationshipIssue(assessment) }))
    .filter(({ issue }) => issue);
  section.classList.toggle("hidden", records.length === 0);
  container.innerHTML = records.map(({ assessment, issue }) => `
    <article class="reconciliation-card">
      <div>
        <span>${escapeHtml(assessment.status.replaceAll("_", " "))}</span>
        <strong>${escapeHtml(assessment.input.assignment_title)}</strong>
        <small>${escapeHtml(assessment.input.student_name)} · Record ${escapeHtml(assessment.id)}</small>
      </div>
      <p><b>${escapeHtml(issue)}.</b> An administrator must relink or remove this legacy record before it can be reviewed or published.</p>
    </article>
  `).join("");
}

function pendingTeacherAssessments() {
  const pendingStatuses = new Set([
    "needs_review", "ready_for_approval", "draft_assessment_ready",
    "knowledge_incomplete", "provisional_source", "awaiting_transcription",
    "wrong_assignment", "needs_teacher_scoring",
  ]);
  return state.assessments
    .filter((assessment) => pendingStatuses.has(assessment.status))
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
}

function refreshTeacherSurfaces() {
  $("#teacher-review-indicator").classList.toggle(
    "hidden",
    pendingTeacherAssessments().length === 0
  );
  renderTeacherModules();
  renderTeacherReconciliation();
}

function focusNewestPendingReview() {
  const pending = pendingTeacherAssessments()[0];
  if (!pending) return false;
  const moduleId = assessmentModuleId(pending);
  const module = state.modules.find((item) => item.id === moduleId);
  if (!module) return false;
  $("#teacher-class-select").value = module.grade_level;
  populateTeacherSubjects();
  $("#teacher-subject-select").value = module.subject;
  $("#teacher-module-select").value = module.id;
  renderTeacherModules();
  return true;
}

function renderTeacherDashboard() {
    const container = $("#queue-list");
    const grade = $("#teacher-class-select")?.value || "";
    const subject = $("#teacher-subject-select")?.value || "";
    const moduleId = $("#teacher-module-select")?.value || "";
    const subjectModuleIds = new Set(
      state.modules
        .filter((module) => module.grade_level === grade && module.subject === subject)
        .map((module) => module.id)
    );
    const records = state.assessments.filter((assessment) => {
      const assessmentModule = assessmentModuleId(assessment);
      return grade && subject && subjectModuleIds.has(assessmentModule) &&
        (!moduleId || assessmentModule === moduleId);
    });
    const needsReviewStatuses = new Set([
      "needs_review", "ready_for_approval", "draft_assessment_ready",
      "knowledge_incomplete", "provisional_source", "awaiting_transcription",
      "wrong_assignment", "needs_teacher_scoring",
    ]);
    const assessed = records.filter((item) => !item.result.provisional && item.result.assessed_points_possible !== 0);
    const average = assessed.length
      ? assessed.reduce((total, item) => total + item.result.percentage, 0) / assessed.length
      : null;
    $("#teacher-evaluated-count").textContent = records.length;
    $("#teacher-needs-review-count").textContent =
      records.filter((item) => needsReviewStatuses.has(item.status)).length;
    $("#teacher-approved-count").textContent =
      records.filter((item) => ["approved", "overridden"].includes(item.status)).length;
    $("#teacher-average-score").textContent = average === null ? "—" : `${average.toFixed(0)}%`;

    if (!grade) {
      $("#teacher-queue-title").textContent = "Select a class and subject";
      container.innerHTML = '<div class="empty-state"><h3>No class selected</h3><p>Choose a class above to load its real assessment records.</p></div>';
      return;
    }
    if (!subject) {
      $("#teacher-queue-title").textContent = `${grade} · Select a subject`;
      container.innerHTML = '<div class="empty-state"><h3>No subject selected</h3><p>Choose a subject to load its real dashboard and submissions.</p></div>';
      return;
    }
    const selectedModule = state.modules.find((module) => module.id === moduleId);
    $("#teacher-queue-title").textContent = selectedModule
      ? selectedModule.title
      : `${grade} · ${subject} submissions`;
    const roster = state.students.filter((student) => student.grade_level === grade);
    const latestByStudent = new Map();
    records.forEach((record) => {
      const key = record.input.student_id || record.input.student_name.toLowerCase();
      if (!latestByStudent.has(key)) latestByStudent.set(key, record);
    });
    const rows = moduleId
      ? roster.map((student) => ({
          student,
          assessment: latestByStudent.get(student.id) || null,
        }))
      : records.map((assessment) => ({
          student: {
            id: assessment.input.student_id,
            student_name: assessment.input.student_name,
            grade_level: grade,
          },
          assessment,
        }));
    const rosterIds = new Set(roster.map((student) => student.id));
    if (moduleId) {
      records
        .filter((record) => !record.input.student_id || !rosterIds.has(record.input.student_id))
        .forEach((record) => rows.push({
          student: {
            id: record.input.student_id,
            student_name: record.input.student_name,
            grade_level: grade,
          },
          assessment: record,
        }));
    }
    if (!rows.length) {
      container.innerHTML = '<div class="empty-state"><h3>No registered learners or submissions</h3><p>Students appear here only after registering for this class or submitting assessed work.</p></div>';
      return;
    }
    container.innerHTML = `
      <div class="submission-table">
        <div class="submission-row submission-header">
          <span>Student</span><span>Homework</span><span>Evidence</span><span>Status</span><span>Score</span><span>Action</span>
        </div>
        ${rows.map(({ student, assessment }) => assessment ? `
          <div class="submission-record">
            <div class="submission-row">
              <div><strong>${escapeHtml(student.student_name)}</strong><small>${new Date(assessment.created_at).toLocaleDateString()}</small></div>
              <div><strong>${escapeHtml(assessment.input.assignment_title)}</strong><small>${escapeHtml(assessment.input.module_title)}</small></div>
              <span>${escapeHtml(submissionTypeLabel(assessment.input.submission_type))}</span>
              <span class="status-badge ${assessment.status}">${assessment.status.replaceAll("_", " ")}</span>
              <strong>${assessment.result.provisional ? "—" : `${assessment.result.percentage.toFixed(0)}%`}</strong>
              <button class="secondary-button toggle-inline-review" data-id="${assessment.id}">Review</button>
            </div>
            <div id="inline-review-${assessment.id}" class="inline-review hidden"></div>
          </div>` : `
          <div class="submission-record">
            <div class="submission-row not-submitted-row">
              <div><strong>${escapeHtml(student.student_name)}</strong><small>Registered in ${escapeHtml(grade)}</small></div>
              <div><strong>${escapeHtml(selectedModule.title)}</strong><small>No assessment record</small></div>
              <span>—</span>
              <span class="status-badge not_submitted">Not submitted</span>
              <strong>—</strong>
              <span class="no-action">Awaiting work</span>
            </div>
          </div>`
        ).join("")}
      </div>`;
    document.querySelectorAll(".toggle-inline-review").forEach((button) => {
      button.addEventListener("click", () => toggleInlineReview(button.dataset.id));
    });
}

function evidenceMarkup(assessment) {
    const localVideoMatch = assessment.input.media_processing_reference?.match(
      /^LOCAL-VIDEO-([0-9a-fA-F-]{36})$/
    );
    const localVideo = localVideoMatch
      ? `<div class="local-video-evidence">
          <strong>Locally retained recording</strong>
          <video controls preload="metadata" src="/api/local-videos/${localVideoMatch[1]}"></video>
          <span>Teacher access only. This video was not sent to the AI agent.</span>
          ${assessment.input.local_video_evidence ? `
            <div class="local-video-pointers">
              <b>Local non-AI evidence summary</b>
              <span>${assessment.input.local_video_evidence.duration_seconds.toFixed(1)} seconds · ${assessment.input.local_video_evidence.transcript_word_count} transcript words · approximately ${assessment.input.local_video_evidence.estimated_words_per_minute.toFixed(1)} words/minute</span>
              <span>Teacher frame pointers: ${assessment.input.local_video_evidence.frame_pointer_seconds.map((second) => `${second.toFixed(1)}s`).join(" · ")}</span>
            </div>
          ` : ""}
        </div>`
      : "";
    if (assessment.evidence_assets?.length) {
      return localVideo + assessment.evidence_assets.map((asset) =>
        asset.mime_type === "application/pdf"
          ? `<div class="evidence-frame"><iframe src="${asset.content_url}" title="${escapeHtml(asset.file_name)}"></iframe><a href="${asset.content_url}" target="_blank" rel="noopener">Open ${escapeHtml(asset.file_name)}</a></div>`
          : `<figure class="evidence-frame"><img src="${asset.content_url}" alt="Submitted homework: ${escapeHtml(asset.file_name)}"><figcaption>${escapeHtml(asset.file_name)}</figcaption></figure>`
      ).join("");
    }
    if (assessment.input.submission_type === "video_and_handnote" && assessment.input.submission) {
      return `${localVideo}<div class="transcript-evidence"><strong>Sanitized transcript assessed by AI</strong><p>${escapeHtml(assessment.input.submission)}</p></div>`;
    }
    return localVideo || '<div class="evidence-unavailable">No viewable evidence was retained for this earlier assessment record.</div>';
}

function assessmentFeedbackDecision(assessment) {
    if (assessment.ai_feedback_deleted) return "delete";
    if (assessment.ai_feedback_accepted === true) return "accept";
    if (assessment.ai_feedback_accepted === false) return "discard";
    return "";
}

function toggleInlineReview(assessmentId) {
    const container = $(`#inline-review-${assessmentId}`);
    const assessment = state.assessments.find((item) => item.id === assessmentId);
    if (!container || !assessment) return;
    if (container.dataset.rendered === "true") {
      container.classList.toggle("hidden");
      return;
    }
    const locked = ["approved", "overridden"].includes(assessment.status);
    const decision = assessmentFeedbackDecision(assessment);
    container.innerHTML = `
      <div class="inline-review-grid">
        <section class="submission-evidence-panel">
          <span class="eyebrow">Submitted homework</span>
          <h3>Evidence reviewed by the assessment</h3>
          <div class="evidence-gallery">${evidenceMarkup(assessment)}</div>
        </section>
        <section class="inline-feedback-panel">
          ${assessment.result.provisional ? `<div class="review-warning"><strong>Teacher action required</strong><span>${escapeHtml(assessment.result.module_alignment)}</span></div>` : ""}
          <div class="inline-ai-card ${decision === "delete" ? "deleted" : ""} ${decision === "discard" ? "discarded" : ""}">
            <div class="ai-feedback-heading"><div><span class="eyebrow">AI-generated feedback</span><h3>Suggestion for teacher review</h3></div><span class="draft-label">Draft</span></div>
            <div class="inline-ai-copy">
              <p>${escapeHtml(assessment.result.personalized_feedback)}</p>
              ${assessment.result.personalized_feedback_hi ? `<p lang="hi">${escapeHtml(assessment.result.personalized_feedback_hi)}</p>` : ""}
            </div>
            <input class="inline-ai-decision" type="hidden" value="${decision}">
            ${locked ? "" : `<div class="ai-feedback-actions">
              <button type="button" data-inline-decision="accept" aria-pressed="false">Accept</button>
              <button type="button" data-inline-decision="discard" aria-pressed="false">Discard</button>
              <button type="button" class="delete" data-inline-decision="delete" aria-pressed="false">Delete from draft</button>
            </div>`}
            <p class="inline-ai-note" role="status" aria-live="polite"></p>
          </div>
          <div class="inline-parameters">
            <div class="inline-section-heading"><div><span class="eyebrow">Assessment parameters</span><h3>Confirm or edit each score</h3></div><span>Unavailable evidence may remain unassessed.</span></div>
            ${assessment.result.criterion_evaluations.map((criterion, index) => `
              <label class="inline-parameter">
                <span><strong>${escapeHtml(criterion.criterion)}</strong><small>${escapeHtml(criterion.rationale)}</small></span>
                <input class="inline-score" data-index="${index}" type="number" min="0" max="${criterion.max_points}" step="0.5" value="${criterion.score}" ${locked ? "disabled" : ""}>
                <em>/ ${criterion.max_points}</em>
              </label>
            `).join("")}
          </div>
          <div class="teacher-feedback-section">
            <span class="eyebrow">Teacher feedback</span>
            <h3>What the student should receive</h3>
            <label>English<textarea class="inline-teacher-feedback" rows="4" ${locked ? "disabled" : ""} placeholder="Enter clear, actionable feedback...">${escapeHtml(assessment.teacher_feedback || "")}</textarea></label>
            <label>Hindi <span class="optional-field">Optional</span>
              <textarea class="inline-teacher-feedback-hi" lang="hi" spellcheck="true" rows="4" ${locked ? "disabled" : ""} placeholder="विद्यार्थी के लिए प्रतिक्रिया...">${escapeHtml(assessment.teacher_feedback_hi || "")}</textarea>
              <span class="hindi-input-help"><b>Type in Hindi:</b> press <kbd>Windows</kbd> + <kbd>Space</kbd>, select <b>Hindi Phonetic</b>, then type phonetically—for example, “vidyarthi ko” becomes “विद्यार्थी को”. You can also paste Hindi text.</span>
            </label>
          </div>
          ${locked ? `<div class="published-review-note">This result has been published to the student.</div>` : `
            <div class="inline-review-actions">
              <button type="button" class="secondary-button inline-submit-review" data-action="edit">Save review</button>
              <button type="button" class="primary-button inline-submit-review" data-action="approve">Approve and publish</button>
              <button type="button" class="text-button open-full-review">Open detailed review</button>
            </div>
            <div class="inline-review-error error-message"></div>
          `}
        </section>
      </div>`;
    container.dataset.rendered = "true";
    container.classList.remove("hidden");
    container.querySelectorAll("[data-inline-decision]").forEach((button) => {
      button.addEventListener("click", () =>
        setInlineAiDecision(container, button.dataset.inlineDecision)
      );
    });
    container.querySelectorAll(".inline-submit-review").forEach((button) => {
      button.addEventListener("click", () =>
        submitInlineReview(assessmentId, button.dataset.action)
      );
    });
    container.querySelector(".open-full-review")?.addEventListener("click", () =>
      openAssessment(assessmentId)
    );
    if (!locked) setInlineAiDecision(container, decision);
}

function setInlineAiDecision(container, decision) {
    const card = container.querySelector(".inline-ai-card");
    card.querySelector(".inline-ai-decision").value = decision;
    card.classList.toggle("decision-confirmed", Boolean(decision));
    card.classList.toggle("deleted", decision === "delete");
    card.classList.toggle("discarded", decision === "discard");
    const labels = { accept: "Accept", discard: "Discard", delete: "Delete from draft" };
    card.querySelectorAll("[data-inline-decision]").forEach((button) => {
      const selected = button.dataset.inlineDecision === decision;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = selected
        ? `${labels[button.dataset.inlineDecision]} selected`
        : labels[button.dataset.inlineDecision];
    });
    card.querySelector(".inline-ai-note").textContent = decision
      ? {
          accept: "Selection confirmed: AI feedback will be used unless teacher feedback replaces it. Select Save review or Approve and publish to apply.",
          discard: "Selection confirmed: AI feedback will remain in the audit record but will not be shown to the student. Select Save review to apply.",
          delete: "Selection confirmed: AI feedback will be removed from the working draft. Select Save review to apply.",
        }[decision]
      : "Action required: choose Accept, Discard, or Delete from draft before saving or publishing.";
    container.querySelectorAll(".inline-submit-review").forEach((button) => {
      button.disabled = !decision;
    });
}

async function submitInlineReview(assessmentId, action) {
    const container = $(`#inline-review-${assessmentId}`);
    const assessment = state.assessments.find((item) => item.id === assessmentId);
    const errorBox = container.querySelector(".inline-review-error");
    errorBox.textContent = "";
    const feedbackDecision = container.querySelector(".inline-ai-decision").value;
    if (!feedbackDecision) {
      errorBox.textContent = "Choose Accept, Discard, or Delete from draft before saving the review.";
      return;
    }
    const criterionScores = {};
    container.querySelectorAll(".inline-score").forEach((input) => {
      const criterion = assessment.result.criterion_evaluations[Number(input.dataset.index)];
      criterionScores[criterion.criterion] = Number(input.value);
    });
    try {
      const updated = await api(`/api/assessments/${assessmentId}/review`, {
        method: "POST",
        body: JSON.stringify({
          action,
          reviewer: "Teacher",
          expected_version: assessment.version,
          criterion_scores: criterionScores,
          ai_feedback_decision: feedbackDecision,
          teacher_feedback: container.querySelector(".inline-teacher-feedback").value.trim(),
          teacher_feedback_hi: container.querySelector(".inline-teacher-feedback-hi").value.trim(),
        }),
      });
      state.assessments = state.assessments.map((item) => item.id === assessmentId ? updated : item);
      refreshTeacherSurfaces();
      renderStudentFeedback();
      notifyAssessmentChanged(action, assessmentId);
      announceAppStatus(
        action === "approve"
          ? "Assessment approved and published to the student."
          : "Teacher review saved successfully."
      );
    } catch (error) {
      if (error.status === 409) {
        await loadQueue({ showLoading: false });
        errorBox.textContent = "This assessment changed in another session. The latest version has been loaded; review it before saving again.";
      } else {
        errorBox.textContent = error.message;
      }
      announceAppStatus(errorBox.textContent, "error");
    }
}

async function loadStudents() {
  try {
    state.students = await api("/api/students");
    const rosterProfile = state.students.find((student) => student.id === state.student?.id);
    if (state.student && !state.student.grade_level && rosterProfile?.grade_level) {
      state.student.grade_level = rosterProfile.grade_level;
      localStorage.setItem("edugrade_student", JSON.stringify(state.student));
    }
    renderTeacherDashboard();
    renderTeacherReconciliation();
    renderStudentSubmissions();
    renderStudentFeedback();
    renderStudentAssignments();
  } catch (error) {
    $("#queue-list").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function studentAssessments() {
  if (!state.student) return [];
  return state.assessments
    .filter((item) => item.input.student_id === state.student.id)
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
}

function studentPublishedFeedback(assessment, language = "en") {
  if (!["approved", "overridden"].includes(assessment.status)) return "";
  const feedback = language === "hi"
    ? assessment.published_feedback_hi
    : assessment.published_feedback;
  return feedback?.trim() || (
    language === "hi"
      ? "आपके शिक्षक ने परिणाम स्वीकृत किया है, लेकिन विस्तृत प्रतिक्रिया अभी उपलब्ध नहीं है।"
      : "Your teacher approved this result, but detailed feedback is not available yet."
  );
}

function conciseStudentText(value, fallback, maxLength = 260) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  const sentences = normalized.match(/[^.!?।]+[.!?।]?/g) || [normalized];
  const concise = sentences.slice(0, 2).join(" ").trim();
  return concise.length <= maxLength
    ? concise
    : `${concise.slice(0, maxLength - 1).trim()}…`;
}

function conciseStudentList(items, fallback) {
  const selected = (items || []).slice(0, 1);
  return selected.length
    ? selected.map((item) => `<li>${escapeHtml(conciseStudentText(item, "", 140))}</li>`).join("")
    : `<li>${escapeHtml(fallback)}</li>`;
}

function effectiveStudentGrade() {
  if (state.student?.grade_level) return state.student.grade_level;
  const rosterGrade = state.students.find((student) => student.id === state.student?.id)?.grade_level;
  if (rosterGrade) return rosterGrade;
  const latest = studentAssessments()[0];
  if (!latest) return "";
  const homework = state.homeworks.find((item) => item.id === latest.input.homework_id);
  if (homework?.grade_level) return homework.grade_level;
  return state.modules.find((module) => module.title === latest.input.module_title)?.grade_level || "";
}

function selectedTestingGrade() {
  const value = $("#student-testing-class")?.value || "__registered__";
  if (value === "__registered__") return effectiveStudentGrade();
  if (value === "__all__") return "";
  return value;
}

function filteredTestingHomeworks() {
  const classValue = $("#student-testing-class")?.value || "__registered__";
  const moduleValue = $("#student-testing-module")?.value || "__all__";
  const grade = selectedTestingGrade();
  return state.homeworks.filter((homework) =>
    (classValue === "__all__" || homework.grade_level === grade) &&
    (moduleValue === "__all__" || homework.module_id === moduleValue)
  );
}

function populateStudentTestingFilters() {
  const classSelect = $("#student-testing-class");
  const moduleSelect = $("#student-testing-module");
  if (!classSelect || !moduleSelect) return;
  const selectedClass = classSelect.value || "__registered__";
  const selectedModule = moduleSelect.value || "__all__";
  const classes = [...new Set(state.homeworks.map((homework) => homework.grade_level))].sort();
  classSelect.innerHTML = `
    <option value="__registered__">My registered class</option>
    <option value="__all__">All classes</option>
    ${classes.map((grade) => `<option value="${escapeHtml(grade)}">${escapeHtml(grade)}</option>`).join("")}
  `;
  classSelect.value = [...classSelect.options].some((option) => option.value === selectedClass)
    ? selectedClass
    : "__registered__";
  const grade = selectedTestingGrade();
  const moduleIds = new Set(
    state.homeworks
      .filter((homework) => classSelect.value === "__all__" || homework.grade_level === grade)
      .map((homework) => homework.module_id)
  );
  const modules = state.modules
    .filter((module) => moduleIds.has(module.id))
    .sort((left, right) => left.title.localeCompare(right.title));
  moduleSelect.innerHTML = '<option value="__all__">All modules</option>' +
    modules.map((module) =>
      `<option value="${module.id}">${escapeHtml(module.grade_level)} · ${escapeHtml(module.title)}</option>`
    ).join("");
  moduleSelect.value = modules.some((module) => module.id === selectedModule)
    ? selectedModule
    : "__all__";
}

function formatFileSize(sizeBytes) {
  if (sizeBytes < 1_000_000) return `${Math.max(1, Math.round(sizeBytes / 1000))} KB`;
  return `${(sizeBytes / 1_000_000).toFixed(1)} MB`;
}

function renderStudentSubmissions() {
  const container = $("#student-submission-list");
  if (!container) return;
  if (!state.student) {
    container.innerHTML = '<div class="empty-state"><p>Register to see your submitted homework documents.</p></div>';
    return;
  }
  const submissions = studentAssessments();
  if (!submissions.length) {
    container.innerHTML = '<div class="empty-state"><p>Your submitted homework documents will appear here.</p></div>';
    return;
  }
  container.innerHTML = submissions.map((item) => {
    const assets = item.evidence_assets || [];
    const documentLabel = `${assets.length} ${assets.length === 1 ? "document" : "documents"}`;
    return `
      <article class="student-submission-card">
        <div class="student-submission-heading">
          <div>
            <span class="eyebrow">${escapeHtml(item.input.module_title)}</span>
            <h3>${escapeHtml(item.input.assignment_title)}</h3>
            <p>${escapeHtml(submissionTypeLabel(item.input.submission_type))} · ${documentLabel}</p>
          </div>
          <span class="status-badge ${escapeHtml(item.status)}">${escapeHtml(item.status.replaceAll("_", " "))}</span>
        </div>
        ${assets.length ? `
          <div class="student-document-list">
            ${assets.map((asset, index) => `
              <a class="student-document" href="${asset.content_url}" target="_blank" rel="noopener">
                <span class="document-number">${index + 1}</span>
                <span><strong>${escapeHtml(asset.file_name)}</strong><small>${escapeHtml(asset.mime_type)} · ${formatFileSize(asset.size_bytes)}</small></span>
                <b>Open</b>
              </a>
            `).join("")}
          </div>
        ` : `<p class="no-retained-documents">This submission has no retained document files.</p>`}
      </article>
    `;
  }).join("");
}

function renderStudentFeedback() {
  const container = $("#student-feedback-list");
  if (!container) return;
  if (!state.student) {
    container.innerHTML = '<div class="empty-state"><p>Register to see teacher-approved feedback.</p></div>';
    return;
  }
  const assessments = studentAssessments();
  if (!assessments.length) {
    container.innerHTML = '<div class="empty-state"><p>Submit homework to see its assessment and feedback status here.</p></div>';
    return;
  }
  container.innerHTML = assessments.map((item) => {
    const approved = ["approved", "overridden"].includes(item.status);
    if (!approved) {
      return `
        <article class="pending-feedback-card">
          <div class="pending-feedback-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v5l3 2M12 3a9 9 0 1 0 9 9"></path></svg>
          </div>
          <div>
            <span class="eyebrow">Teacher review pending</span>
            <h3>${escapeHtml(item.input.assignment_title)}</h3>
            <p>Your work was received. Your teacher is checking it before marks and feedback are shared.</p>
            <div class="pending-feedback-meta">
              <span>${escapeHtml(item.input.module_title)}</span>
              <b>${escapeHtml(item.status.replaceAll("_", " "))}</b>
              <time>${new Date(item.created_at).toLocaleString()}</time>
            </div>
          </div>
        </article>`;
    }
    const approvedFeedback = studentPublishedFeedback(item);
    const approvedFeedbackHi = item.published_feedback_hi
      ? studentPublishedFeedback(item, "hi")
      : "आपका परिणाम शिक्षक ने स्वीकृत किया है। अगला कदम समझने के लिए अंग्रेज़ी प्रतिक्रिया और नीचे दिए गए सुधार बिंदु देखें।";
    const conciseEnglish = conciseStudentText(
      approvedFeedback,
      "Your teacher approved this result. Review the next step below."
    );
    const conciseHindi = conciseStudentText(
      approvedFeedbackHi,
      "आपका परिणाम शिक्षक ने स्वीकृत किया है। नीचे दिया गया अगला कदम देखें।"
    );
    const nextStep = conciseStudentText(
      item.result.recommendations?.[0],
      "Review the teacher feedback and improve one area in your next attempt.",
      180
    );
    return `
    <article class="published-feedback-card concise-feedback-card">
      <div class="published-feedback-heading">
        <div>
          <span class="eyebrow">${escapeHtml(item.input.module_title)}</span>
          <h3>${escapeHtml(item.input.assignment_title)}</h3>
          <small>${escapeHtml(submissionTypeLabel(item.input.submission_type))} · teacher approved</small>
        </div>
        <div class="student-score"><strong>${item.result.percentage.toFixed(0)}%</strong><span>Your score</span></div>
      </div>
      <div class="feedback-language-grid">
        <section lang="en">
          <span>English feedback</span>
          <p>${escapeHtml(conciseEnglish)}</p>
        </section>
        <section lang="hi">
          <span>हिंदी प्रतिक्रिया</span>
          <p>${escapeHtml(conciseHindi)}</p>
        </section>
      </div>
      <div class="student-feedback-actions">
        <section class="feedback-action positive">
          <span>Keep doing</span>
          <ul>${conciseStudentList(item.result.strengths, "Keep following the assignment steps carefully.")}</ul>
        </section>
        <section class="feedback-action improve">
          <span>Improve next</span>
          <ul>${conciseStudentList(item.result.learning_gaps, "No specific improvement point was recorded.")}</ul>
        </section>
        <section class="feedback-action next">
          <span>Your next action</span>
          <p>${escapeHtml(nextStep)}</p>
        </section>
      </div>
      <details class="student-result-explanation student-score-details">
        <summary>
          <span>
            <strong>View score details</strong>
            <small>Optional: see marks for each assessment area.</small>
          </span>
        </summary>
        <div class="student-result-explanation-content">
          <div class="compact-score-list">
            ${item.result.criterion_evaluations.map((criterion) => `
              <div><strong>${escapeHtml(criterion.criterion)}</strong><span>${criterion.assessed ? `${criterion.score}/${criterion.max_points}` : "Not assessed"}</span></div>
            `).join("")}
          </div>
          <p class="student-explanation-note">Only teacher-approved results are shown. Detailed evidence and governance information remain available to educators in Agent Inspector.</p>
        </div>
      </details>
    </article>
  `;
  }).join("");
}

function selectedHomework() {
  return state.homeworks.find((item) => item.id === $("#homework-select").value);
}

function homeworkIsDueToday(homework, today = new Date()) {
  const due = homework.due_label.trim();
  if (/^due today$/i.test(due)) return true;
  const weekday = today.toLocaleDateString("en-US", { weekday: "long" });
  if (new RegExp(`^due\\s+${weekday}$`, "i").test(due)) return true;
  const explicitDate = new Date(due.replace(/^due\s+/i, ""));
  return !Number.isNaN(explicitDate.getTime()) &&
    explicitDate.getFullYear() === today.getFullYear() &&
    explicitDate.getMonth() === today.getMonth() &&
    explicitDate.getDate() === today.getDate();
}

function studentHomeworkStatus(homework) {
  const submissions = state.assessments.filter((item) =>
    item.input.student_id === state.student?.id && item.input.homework_id === homework.id
  );
  if (submissions.some((item) => ["approved", "overridden"].includes(item.status))) {
    return { key: "feedback", label: "Feedback ready" };
  }
  if (submissions.length) return { key: "submitted", label: "Submitted" };
  if (loadStartedHomeworks().has(homework.id)) return { key: "started", label: "In progress" };
  return { key: "pending", label: "Not started" };
}

function studentIndicatorMarkup(status) {
  const icons = {
    pending: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h7a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3H3zM21 5h-5a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h5z"></path></svg>',
    started: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h7a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H3zM15 7h5v9h-4"></path><path d="m12 17 7-7 2 2-7 7-3 1z"></path></svg>',
    submitted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h15v14H4zM7 3h15v14h-3"></path><path d="m8 15 7-7 2 2-7 7-3 1z"></path></svg>',
    feedback: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h7a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3H3zM21 5h-5a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h5z"></path><path d="m8 11 2 2 4-5"></path></svg>',
  };
  return icons[status];
}

function updateStudentWorkIndicator(homeworks) {
  const indicator = $("#student-work-indicator");
  if (!state.student || !homeworks.length) {
    indicator.className = "student-work-indicator hidden";
    indicator.innerHTML = "";
    return;
  }
  const statuses = homeworks.map(studentHomeworkStatus);
  let status = "pending";
  let label = "Assignments pending";
  if (statuses.every((item) => item.key === "feedback")) {
    status = "feedback";
    label = "All feedback is ready";
  } else if (statuses.every((item) => ["submitted", "feedback"].includes(item.key))) {
    status = "submitted";
    label = "All assignments submitted";
  } else if (statuses.some((item) => item.key === "started")) {
    status = "started";
    label = "Assignment in progress";
  }
  indicator.className = `student-work-indicator ${status}`;
  indicator.setAttribute("aria-label", label);
  indicator.title = label;
  indicator.innerHTML = studentIndicatorMarkup(status);
}

function renderStudentAssignments() {
  const container = $("#student-assignment-list");
  if (!container) return;
  const registeredGrade = effectiveStudentGrade();
  if (!registeredGrade) {
    $("#student-task-count").textContent = "0";
    $("#student-task-label").textContent = "Class tasks";
    $("#student-class-badge").textContent = "Class not selected";
    $("#student-assignment-title").textContent = "Today’s assignments";
    $("#student-assignment-context").textContent = "Register with your class to see the work assigned to you.";
    container.innerHTML = '<div class="teacher-selection-empty">Register to load your class assignments.</div>';
    updateStudentWorkIndicator([]);
    renderStudentProgress([]);
    return;
  }
  const registeredHomeworks = state.homeworks.filter(
    (homework) => homework.grade_level === registeredGrade
  );
  const testingHomeworks = filteredTestingHomeworks();
  const testingClass = $("#student-testing-class")?.value || "__registered__";
  const today = testingClass === "__registered__"
    ? testingHomeworks.filter((homework) => homeworkIsDueToday(homework))
    : [];
  const displayed = today.length ? today : testingHomeworks;
  $("#student-task-count").textContent = displayed.length;
  $("#student-task-label").textContent = testingClass === "__registered__" && today.length
    ? "Due today"
    : "Visible tasks";
  $("#student-class-badge").textContent = testingClass === "__all__"
    ? "All classes · testing"
    : `${selectedTestingGrade()}${testingClass === "__registered__" ? "" : " · testing"}`;
  $("#student-assignment-title").textContent = testingClass === "__all__"
    ? "All class assignments"
    : today.length ? "Today’s assignments" : "Available class assignments";
  $("#student-assignment-context").textContent = testingClass === "__all__"
    ? "Showing assignments and linked modules across every class for local testing."
    : testingClass === "__registered__"
      ? (today.length
          ? `${today.length} ${today.length === 1 ? "assignment is" : "assignments are"} scheduled for today.`
          : "No assignment has an exact date for today, so currently available class work is shown.")
      : `Showing ${selectedTestingGrade()} assignments for local testing.`;
  container.innerHTML = displayed.length
    ? displayed.map((homework) => {
        const status = studentHomeworkStatus(homework);
        return `
          <button type="button" class="student-assignment-card ${status.key} ${homework.id === $("#homework-select").value ? "selected" : ""}" data-homework-id="${homework.id}">
            <span class="student-assignment-status">${escapeHtml(status.label)}</span>
            <strong>${escapeHtml(homework.title)}</strong>
            <small>${escapeHtml(homework.grade_level)} · ${escapeHtml(homework.subject)} · ${escapeHtml(state.modules.find((module) => module.id === homework.module_id)?.title || "Linked module")} · ${escapeHtml(homework.due_label)}</small>
            <b>${homework.id === $("#homework-select").value ? "Selected" : "Open assignment"}</b>
          </button>`;
      }).join("")
    : '<div class="teacher-selection-empty">No assignments are available for this class.</div>';
  container.querySelectorAll("[data-homework-id]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#homework-select").value = button.dataset.homeworkId;
      renderHomeworkBrief();
      renderSubmissionChoices();
      configureSubmissionMode();
      renderStudentAssignments();
    });
  });
  updateStudentWorkIndicator(registeredHomeworks);
  renderStudentProgress(registeredHomeworks);
}

function renderStudentProgress(classHomeworks) {
  const progress = $("#student-subject-progress");
  if (!state.student) {
    $("#student-assigned-count").textContent = "0";
    $("#student-submitted-count").textContent = "0";
    $("#student-awaiting-count").textContent = "0";
    $("#student-feedback-count").textContent = "0";
    progress.innerHTML = '<div class="teacher-selection-empty">Register to view learning progress.</div>';
    return;
  }
  const latestByHomework = new Map();
  studentAssessments().forEach((assessment) => {
    if (!latestByHomework.has(assessment.input.homework_id)) {
      latestByHomework.set(assessment.input.homework_id, assessment);
    }
  });
  const submitted = classHomeworks.filter((homework) => latestByHomework.has(homework.id));
  const feedbackReady = submitted.filter((homework) =>
    ["approved", "overridden"].includes(latestByHomework.get(homework.id).status)
  );
  $("#student-assigned-count").textContent = classHomeworks.length;
  $("#student-submitted-count").textContent = submitted.length;
  $("#student-awaiting-count").textContent = submitted.length - feedbackReady.length;
  $("#student-feedback-count").textContent = feedbackReady.length;

  const subjects = [...new Set(classHomeworks.map((homework) => homework.subject))].sort();
  progress.innerHTML = subjects.length
    ? subjects.map((subject) => {
        const subjectHomeworks = classHomeworks.filter((homework) => homework.subject === subject);
        const subjectSubmissions = subjectHomeworks
          .map((homework) => latestByHomework.get(homework.id))
          .filter(Boolean);
        const approved = subjectSubmissions.filter((assessment) =>
          ["approved", "overridden"].includes(assessment.status) &&
          !assessment.result.provisional &&
          assessment.result.assessed_points_possible !== 0
        );
        const average = approved.length
          ? approved.reduce((sum, assessment) => sum + assessment.result.percentage, 0) / approved.length
          : null;
        const completion = subjectHomeworks.length
          ? Math.round((subjectSubmissions.length / subjectHomeworks.length) * 100)
          : 0;
        return `
          <article class="student-progress-row">
            <div>
              <strong>${escapeHtml(subject)}</strong>
              <span>${subjectSubmissions.length} of ${subjectHomeworks.length} assignments submitted</span>
            </div>
            <div class="student-progress-track"><span style="width:${completion}%"></span></div>
            <b>${subjectSubmissions.length === 0
              ? "Not started"
              : average === null
                ? "Teacher checking"
                : `Approved average: ${average.toFixed(0)}%`}</b>
          </article>`;
      }).join("")
    : '<div class="teacher-selection-empty">No subjects are available for this class.</div>';
}

function submissionTypeLabel(type) {
  return {
    handwritten_image: "Photos of handwritten pages",
    handwritten_pdf: "Scanned PDF",
    mcq: "Portal quiz",
    video_and_handnote: "Local-only video with sanitized transcript",
  }[type] || type.replaceAll("_", " ");
}

function instructionParts(instructions) {
  const normalized = instructions.replaceAll("\r", "").trim();
  const parts = normalized
    .split(/\n+\s*[-•]?\s*|\s+(?=\d+[\).]\s)/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 1) return { introduction: "", steps: parts };
  const startsWithNumber = /^\d+[\).]\s/.test(parts[0]);
  return {
    introduction: startsWithNumber ? "" : parts.shift(),
    steps: parts.map((part) => part.replace(/^\d+[\).]\s*/, "")),
  };
}

function instructionStepMarkup(step) {
  const match = step.match(/^([^:]{1,40}):\s*(.+)$/);
  return match
    ? `<strong>${escapeHtml(match[1])}</strong><span>${escapeHtml(match[2])}</span>`
    : `<span>${escapeHtml(step)}</span>`;
}

function assignmentInstructionsMarkup(instructions) {
  const parts = instructionParts(instructions);
  return `
    ${parts.introduction ? `<p class="instruction-intro">${escapeHtml(parts.introduction)}</p>` : ""}
    <ol class="clear-instruction-steps">
      ${parts.steps.map((step) => `<li>${instructionStepMarkup(step)}</li>`).join("")}
    </ol>
  `;
}

function renderHomeworkBrief() {
  const homework = selectedHomework();
  const brief = $("#homework-brief");
  if (!homework) {
    brief.className = "homework-brief empty";
    brief.textContent = "Select an assigned homework to view its instructions and rubric.";
    updateSubmissionJourney();
    return;
  }
  const module = state.modules.find((item) => item.id === homework.module_id);
  const learnerContent = (module?.content || "")
    .replace(/^Instruction to the teacher:[\s\S]*?\n\n/i, "")
    .replace(/\n\nSAMPLE SCOPE:[\s\S]*$/i, "")
    .trim();
  brief.className = "homework-brief";
  brief.innerHTML = `
    <div class="homework-brief-header">
      <div>
        <span class="eyebrow">${escapeHtml(homework.grade_level)} · ${escapeHtml(homework.subject)}</span>
        <h3>${escapeHtml(homework.title)}</h3>
      </div>
      <span class="due-badge">${escapeHtml(homework.due_label)}</span>
    </div>
    <section class="assignment-instructions">
      <h4>What you need to do</h4>
      ${assignmentInstructionsMarkup(homework.instructions)}
    </section>
    ${learnerContent ? `
      <section class="student-reading-material">
        <div class="student-reading-heading">
          <div><span class="eyebrow">Assigned reading</span><h4>Read this content before starting</h4></div>
          <span>Teacher-approved module content</span>
        </div>
        <div class="student-reading-copy">${escapeHtml(learnerContent).replaceAll("\n", "<br>")}</div>
      </section>
    ` : ""}
    <div class="homework-section-label">Accepted submission formats</div>
    <div class="homework-meta">
      ${homework.allowed_submission_types.map((type) =>
        `<span>${escapeHtml(submissionTypeLabel(type))}</span>`
      ).join("")}
    </div>
    <div class="homework-section-label rubric-label">How your work will be reviewed</div>
    <div class="homework-rubric" role="list">
      ${homework.rubric.map((item) =>
        `<div role="listitem">
          <span>${escapeHtml(item.name)}</span>
          <strong>${item.max_points} points</strong>
        </div>`
      ).join("")}
    </div>
  `;
}

function renderSubmissionChoices() {
  const homework = selectedHomework();
  const section = $("#submission-choice-section");
  const currentType = $("#submission-type").value;
  if (!homework) {
    $("#submission-type").value = "";
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  document.querySelectorAll(".submission-choice").forEach((choice) => {
    const available = homework.allowed_submission_types.includes(choice.dataset.submissionType);
    choice.classList.toggle("hidden", !available);
    choice.classList.toggle("selected", available && choice.dataset.submissionType === currentType);
    choice.setAttribute("aria-pressed", String(available && choice.dataset.submissionType === currentType));
  });
  if (!homework.allowed_submission_types.includes(currentType)) {
    $("#submission-type").value = "";
  }
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
  $("#mcq-panel").querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      markSelectedHomeworkStarted();
      updateSubmissionJourney();
    });
  });
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
  renderSelectedFiles();
  document.querySelectorAll(".submission-choice").forEach((choice) => {
    const selected = choice.dataset.submissionType === type;
    choice.classList.toggle("selected", selected);
    choice.setAttribute("aria-pressed", String(selected));
    choice.querySelector("b").textContent = selected ? "Selected" : "Choose";
  });

  if (!homework || !type) {
    updateSubmissionJourney();
    return;
  }
  if (!homework.allowed_submission_types.includes(type)) {
    $("#form-error").textContent = "This format is not available for the selected homework.";
    $("#submission-type").value = "";
    updateSubmissionJourney();
    return;
  }
  if (type === "mcq") {
    renderMcq(homework);
    $("#mcq-panel").classList.remove("hidden");
  } else {
    filePanel.classList.remove("hidden");
    if (type === "handwritten_image") {
      fileInput.accept = "image/jpeg,image/png,image/webp";
      fileInput.multiple = true;
      help.textContent = "Upload up to eight clear JPG, PNG, or WEBP photos. Keep pages in reading order.";
    } else if (type === "handwritten_pdf") {
      fileInput.accept = "application/pdf,.pdf";
      fileInput.multiple = true;
      help.textContent = "Upload up to eight PDFs containing clear scans or photos of the handwritten pages.";
    } else {
      fileInput.accept = "video/*";
      fileInput.multiple = false;
      help.textContent = "Select a video up to 100 MB. It is saved only by the locally hosted web app and never sent to the AI agent.";
      $("#external-processing-panel").classList.remove("hidden");
    }
  }
  updateSubmissionJourney();
}

function renderSelectedFiles() {
  const container = $("#submission-file-list");
  const files = [...$("#submission-file").files];
  if (!files.length || $("#submission-type").value === "video_and_handnote") {
    container.innerHTML = "";
    container.classList.add("hidden");
    updateSubmissionJourney();
    return;
  }
  container.innerHTML = `
    <div class="selected-file-heading">
      <strong>${files.length} ${files.length === 1 ? "document" : "documents"} selected</strong>
      <span>Files will be submitted in this order.</span>
    </div>
    <ol>
      ${files.map((file) => `<li><span>${escapeHtml(file.name)}</span><small>${formatFileSize(file.size)}</small></li>`).join("")}
    </ol>
  `;
  container.classList.remove("hidden");
  updateSubmissionJourney();
}

function submissionReadiness() {
  const homework = selectedHomework();
  const type = $("#submission-type").value;
  const assignmentReady = Boolean(homework);
  const formatReady = assignmentReady && homework.allowed_submission_types.includes(type);
  let evidenceReady = false;
  let evidenceLabel = "No evidence added";
  if (formatReady && (type === "handwritten_image" || type === "handwritten_pdf")) {
    const files = [...$("#submission-file").files];
    evidenceReady = files.length > 0;
    evidenceLabel = evidenceReady
      ? `${files.length} ${files.length === 1 ? "document" : "documents"} selected`
      : "Add at least one homework document";
  } else if (formatReady && type === "mcq") {
    const answered = homework.mcq_questions.filter((question) =>
      document.querySelector(`input[name="mcq-${question.id}"]:checked`)
    ).length;
    evidenceReady = homework.mcq_questions.length > 0 && answered === homework.mcq_questions.length;
    evidenceLabel = `${answered} of ${homework.mcq_questions.length} questions answered`;
  } else if (formatReady && type === "video_and_handnote") {
    const video = state.recordedVideo || $("#submission-file").files[0];
    evidenceReady = Boolean(video);
    evidenceLabel = evidenceReady ? `Video selected: ${video.name}` : "Select or record a video";
  }
  const permissionReady = $("#permission-confirmed").checked;
  return {
    homework,
    type,
    assignmentReady,
    formatReady,
    evidenceReady,
    evidenceLabel,
    permissionReady,
    ready: assignmentReady && formatReady && evidenceReady && permissionReady,
  };
}

function updateSubmissionJourney() {
  const status = submissionReadiness();
  const steps = [
    ["assignment", status.assignmentReady],
    ["format", status.formatReady],
    ["evidence", status.evidenceReady],
    ["confirm", status.ready],
  ];
  const firstIncomplete = steps.findIndex(([, complete]) => !complete);
  steps.forEach(([name, complete], index) => {
    const element = document.querySelector(`[data-submission-step="${name}"]`);
    if (!element) return;
    element.classList.toggle("complete", complete);
    element.classList.toggle("current", !complete && index === firstIncomplete);
  });
  const readiness = $("#submission-readiness");
  if (!readiness) return;
  readiness.classList.toggle("ready", status.ready);
  readiness.textContent = status.ready
    ? "Ready for final review. Confirm the assignment and evidence before submitting."
    : !status.assignmentReady
      ? "Select an assignment to begin."
      : !status.formatReady
        ? "Choose one of the approved submission formats."
        : !status.evidenceReady
          ? status.evidenceLabel
          : "Confirm that this is your work and permission is available.";
}

function closeSubmissionConfirmation() {
  $("#submission-confirmation-overlay").classList.add("hidden");
}

function openSubmissionConfirmation() {
  const status = submissionReadiness();
  if (!status.ready) {
    $("#form-error").textContent = $("#submission-readiness").textContent;
    return false;
  }
  $("#submission-confirmation-summary").innerHTML = `
    <div><span>Assignment</span><strong>${escapeHtml(status.homework.title)}</strong></div>
    <div><span>Class and subject</span><strong>${escapeHtml(status.homework.grade_level)} · ${escapeHtml(status.homework.subject)}</strong></div>
    <div><span>Submission format</span><strong>${escapeHtml(submissionTypeLabel(status.type))}</strong></div>
    <div><span>Evidence ready</span><strong>${escapeHtml(status.evidenceLabel)}</strong></div>
    <div><span>What happens next</span><strong>EduGrade prepares a rubric-grounded draft. An educator reviews it before marks or feedback are released.</strong></div>
  `;
  $("#submission-confirmation-overlay").classList.remove("hidden");
  return true;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The homework file could not be read."));
    reader.readAsDataURL(file);
  });
}

async function uploadLocalVideo(file) {
  if (file.size > 100_000_000) {
    throw new Error("The video must be 100 MB or smaller.");
  }
  const response = await fetch("/api/local-videos", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "video/webm",
      "X-File-Name": encodeURIComponent(file.name || "recorded-homework.webm"),
    },
    body: file,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || "The video could not be saved locally.");
  }
  $("#media-processing-reference").value = payload.reference;
  const statusBox = $("#local-video-status");
  statusBox.innerHTML = `<strong>Saved on this machine</strong><span>${escapeHtml(payload.storage_location)}</span><small>The AI agent receives no video bytes or frames.</small>`;
  statusBox.classList.remove("hidden");
  return payload;
}

function buildLocalVideoEvidence(transcription) {
  const durationSeconds = transcription.duration_seconds || 0;
  const transcriptText = transcription.transcript || "";
  const transcriptWordCount = transcriptText.trim().split(/\s+/).filter(Boolean).length;
  const estimatedWordsPerMinute = transcription.estimated_words_per_minute || 0;
  const segmentPointers = (transcription.segments || [])
    .map((segment) => segment.start_seconds)
    .filter((value, index, values) => values.indexOf(value) === index);
  const framePointerSeconds = segmentPointers.length
    ? segmentPointers.slice(0, 12)
    : [0, .25, .5, .75, 1]
        .map((position) => Math.round(durationSeconds * position * 10) / 10)
        .filter((value, index, values) => values.indexOf(value) === index);
  return {
    method: "deterministic_local_browser",
    duration_seconds: Math.round(durationSeconds * 10) / 10,
    transcript_word_count: transcriptWordCount,
    estimated_words_per_minute: Math.round(estimatedWordsPerMinute * 10) / 10,
    frame_pointer_seconds: framePointerSeconds,
    contains_video_data: false,
  };
}

function renderModuleLibrary() {
  const query = $("#module-search").value.trim().toLowerCase();
  const grade = $("#module-grade-filter").value;
  const subject = $("#module-subject-filter").value;
  const filtered = state.modules.filter((module) => {
    const matchesQuery = !query ||
      `${module.title} ${module.subject} ${module.grade_level} ${module.source_reference} ${module.source_type}`.toLowerCase().includes(query);
    return matchesQuery &&
      (!grade || module.grade_level === grade) &&
      (!subject || module.subject === subject);
  });
  $("#module-results-count").textContent =
    `${filtered.length} of ${state.modules.length} modules`;
  $("#module-list").innerHTML = filtered.length
    ? filtered.map((module) => `
        <div class="module-item view-module-detail" role="button" tabindex="0" data-view-module-id="${module.id}" aria-label="View ${escapeHtml(module.title)} content and assignments">
        <div class="module-title-row">
          <strong>${escapeHtml(module.title)}</strong>
          ${module.source_reference?.toLowerCase().includes("wes")
            ? '<span class="source-status wes">WES module</span>'
            : ""}
          ${module.source_status && module.source_status !== "approved"
            ? `<span class="source-status ${module.source_status}">${escapeHtml(module.source_status)}</span>`
            : ""}
        </div>
        <div class="module-actions">
          <span>${escapeHtml(module.subject)} · ${escapeHtml(module.grade_level)} · ${module.evaluation_rubric.length} evaluation parameters</span>
          <button class="secondary-button edit-module-rubric" type="button" data-module-id="${module.id}">Edit rubric</button>
        </div>
        ${module.source_reference
          ? `<p class="module-source-note">Source: ${escapeHtml(module.source_reference)}${module.source_notes ? ` · ${escapeHtml(module.source_notes)}` : ""}</p>`
          : ""}
      </div>`).join("")
    : '<div class="empty-state"><p>No modules match these filters.</p></div>';
  document.querySelectorAll(".edit-module-rubric").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openRubricEditor(button.dataset.moduleId);
    });
  });
  document.querySelectorAll(".view-module-detail").forEach((item) => {
    item.addEventListener("click", () => openModuleDetails(item.dataset.viewModuleId));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openModuleDetails(item.dataset.viewModuleId);
      }
    });
  });
}

function openModuleDetails(moduleId) {
  const module = state.modules.find((item) => item.id === moduleId);
  if (!module) return;
  const homeworks = state.homeworks.filter((homework) => homework.module_id === moduleId);
  $("#module-detail-content").innerHTML = `
    <div class="module-detail-header">
      <span class="eyebrow">Governed learning module</span>
      <h2 id="module-detail-title">${escapeHtml(module.title)}</h2>
      <p>${escapeHtml(module.grade_level)} · ${escapeHtml(module.subject)} · ${escapeHtml(module.source_status)}</p>
    </div>
    <div class="module-detail-meta">
      <div><span>Source</span><strong>${escapeHtml(module.source_reference || "Teacher-provided content")}</strong></div>
      <div><span>Source type</span><strong>${escapeHtml(module.source_type.replaceAll("_", " "))}</strong></div>
      <div><span>Evaluation parameters</span><strong>${module.evaluation_rubric.length}</strong></div>
    </div>
    <section class="module-detail-section">
      <span class="eyebrow">Module content</span>
      <h3>Content available to the learning workflow</h3>
      <div class="module-detail-copy">${escapeHtml(module.content).replaceAll("\n", "<br>")}</div>
    </section>
    <section class="module-detail-section">
      <span class="eyebrow">Assignment instructions</span>
      <h3>${homeworks.length ? `${homeworks.length} linked ${homeworks.length === 1 ? "assignment" : "assignments"}` : "No linked assignment"}</h3>
      <div class="module-assignment-list">
        ${homeworks.length ? homeworks.map((homework) => `
          <article>
            <div><strong>${escapeHtml(homework.title)}</strong><span>${escapeHtml(homework.due_label)}</span></div>
            <div class="module-assignment-instructions">
              <h4>What the student needs to do</h4>
              ${assignmentInstructionsMarkup(homework.instructions)}
            </div>
            <div class="module-assignment-submit">
              <b>What to submit</b>
              <span>${homework.allowed_submission_types.map(submissionTypeLabel).map(escapeHtml).join(" · ")}</span>
            </div>
          </article>
        `).join("") : '<div class="teacher-selection-empty">No homework has been linked to this module.</div>'}
      </div>
    </section>
    <section class="module-detail-section">
      <span class="eyebrow">Evaluation rubric</span>
      <div class="module-detail-rubric">
        ${module.evaluation_rubric.map((criterion) => `
          <div><span><strong>${escapeHtml(criterion.name)}</strong><small>${escapeHtml(criterion.description)}</small></span><b>${criterion.max_points} points</b></div>
        `).join("")}
      </div>
    </section>
  `;
  $("#module-detail-overlay").classList.remove("hidden");
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
  const welcome = $("#student-welcome");
  const safetyLabel = $("#student-safety-label");
  const consentHeading = $("#student-consent-heading");
  if (!state.student) {
    welcome.textContent = "Welcome.";
    safetyLabel.textContent = "Learner account safety";
    consentHeading.textContent = "Verified consent protects media submissions.";
    badge.textContent = "First login required";
    badge.className = "status-badge needs_review";
    $("#consent-reference-display").textContent = "";
    return;
  }
  const learnerName = state.student.student_name?.trim() || "Learner";
  const adult = state.student.learner_type === "adult_trainee";
  welcome.textContent = `Welcome back, ${learnerName}.`;
  safetyLabel.textContent = adult ? "Adult trainee account safety" : "Student account safety";
  consentHeading.textContent = adult
    ? "Your verified consent protects media submissions."
    : "Parent or guardian consent protects media submissions.";
  badge.textContent = state.student.video_processing_approved
    ? `${adult ? "Adult consent" : "Parent consent"} verified · video approved`
    : `${adult ? "Adult consent" : "Parent consent"} verified · video disabled`;
  badge.className = "status-badge ready_for_approval";
  $("#consent-reference-display").textContent =
    `Consent record: ${state.student.consent_reference} · Version ${state.student.consent_version}`;
}

function requireStudentRegistration() {
  state.student = getStoredStudent();
  updateConsentStatus();
  if (!state.student) $("#registration-overlay").classList.remove("hidden");
}

function closeRegistration() {
  $("#registration-overlay").classList.add("hidden");
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
            <div><strong>${result.provisional ? "Pending" : `${result.percentage.toFixed(0)}%`}</strong><span>${result.assessed_points_possible === 0 ? "Teacher review" : `${result.total_score}/${result.max_score} pts`}</span></div>
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
              ${criterion.assessed === false
                ? `<div class="not-assessed">Not assessed: ${escapeHtml(criterion.not_assessed_reason)}</div>`
                : ""}
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
          <div id="ai-feedback-review" class="ai-feedback-review ${item.ai_feedback_deleted ? "deleted" : ""}">
            <div class="ai-feedback-heading">
              <div>
                <span class="eyebrow">AI-generated suggestion</span>
                <h4>Review before using</h4>
              </div>
              <span class="draft-label">Draft</span>
            </div>
            <div class="ai-feedback-copy">
              <strong>English</strong>
              <p>${escapeHtml(result.personalized_feedback)}</p>
              <strong>Hindi</strong>
              <p>${escapeHtml(result.personalized_feedback_hi || "Hindi feedback was not returned.")}</p>
            </div>
            <input id="ai-feedback-decision" type="hidden" value="${assessmentFeedbackDecision(item)}">
            ${reviewLocked ? "" : `
              <div class="ai-feedback-actions">
                <button type="button" class="ai-feedback-action accept" data-decision="accept" aria-pressed="false">Accept</button>
                <button type="button" class="ai-feedback-action discard" data-decision="discard" aria-pressed="false">Discard</button>
                <button type="button" class="ai-feedback-action delete" data-decision="delete" aria-pressed="false">Delete from draft</button>
              </div>
            `}
            <p id="ai-feedback-decision-note" class="ai-feedback-decision-note" role="status" aria-live="polite"></p>
          </div>
          <label>Final score
            <input id="review-score" type="number" min="0" max="${result.max_score}" step="0.5" value="${result.total_score}" ${reviewLocked ? "disabled" : ""}>
          </label>
          <div class="teacher-feedback-section">
            <span class="eyebrow">Teacher feedback</span>
            <h4>Add the feedback the student should receive</h4>
            <p>This is separate from the AI suggestion and remains fully editable.</p>
            <label>Feedback · English
              <textarea id="teacher-feedback" rows="5" placeholder="Add personalized teacher guidance..." ${reviewLocked ? "disabled" : ""}>${escapeHtml(item.teacher_feedback || "")}</textarea>
            </label>
            <label>Feedback · Hindi
              <span class="optional-field">Optional</span>
              <textarea id="teacher-feedback-hi" lang="hi" spellcheck="true" rows="5" placeholder="शिक्षक की व्यक्तिगत प्रतिक्रिया..." ${reviewLocked ? "disabled" : ""}>${escapeHtml(item.teacher_feedback_hi || "")}</textarea>
              <span class="hindi-input-help"><b>Type in Hindi:</b> press <kbd>Windows</kbd> + <kbd>Space</kbd>, select <b>Hindi Phonetic</b>, then type phonetically—for example, “vidyarthi ko” becomes “विद्यार्थी को”. You can also paste Hindi text.</span>
            </label>
          </div>
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
              <button class="danger-button review-action" data-action="override">Override AI draft score</button>
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
  document.querySelectorAll(".ai-feedback-action").forEach((button) => {
    button.addEventListener("click", () => setAiFeedbackDecision(button.dataset.decision));
  });
  if (!reviewLocked) setAiFeedbackDecision($("#ai-feedback-decision").value);
}

function setAiFeedbackDecision(decision) {
  const input = $("#ai-feedback-decision");
  const panel = $("#ai-feedback-review");
  const note = $("#ai-feedback-decision-note");
  if (!input || !panel || !note) return;
  input.value = decision;
  panel.classList.toggle("decision-confirmed", Boolean(decision));
  panel.classList.toggle("deleted", decision === "delete");
  panel.classList.toggle("discarded", decision === "discard");
  const labels = { accept: "Accept", discard: "Discard", delete: "Delete from draft" };
  document.querySelectorAll(".ai-feedback-action").forEach((button) => {
    const selected = button.dataset.decision === decision;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = selected
      ? `${labels[button.dataset.decision]} selected`
      : labels[button.dataset.decision];
  });
  note.textContent = decision
    ? {
        accept: "Selection confirmed: AI feedback will be used unless teacher feedback below replaces it. Save or approve to apply.",
        discard: "Selection confirmed: AI feedback will not be released to the student. Save or approve to apply.",
        delete: "Selection confirmed: AI feedback will be removed from the working draft. Save or approve to apply.",
      }[decision]
    : "Action required: choose Accept, Discard, or Delete from draft before saving or publishing.";
  document.querySelectorAll(".review-action").forEach((button) => {
    button.disabled = !decision;
  });
}

async function submitReview(action) {
  const errorBox = $("#review-error");
  errorBox.textContent = "";
  if (!$("#ai-feedback-decision").value) {
    errorBox.textContent = "Choose Accept, Discard, or Delete from draft before saving the review.";
    return;
  }
  try {
    const payload = {
      action,
      reviewer: $("#reviewer").value.trim(),
      expected_version: state.current.version,
      notes: $("#review-notes").value.trim(),
      total_score: Number($("#review-score").value),
      ai_feedback_decision: $("#ai-feedback-decision").value,
      teacher_feedback: $("#teacher-feedback").value.trim(),
      teacher_feedback_hi: $("#teacher-feedback-hi").value.trim(),
    };
    state.current = await api(`/api/assessments/${state.current.id}/review`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderTrace(state.current.execution_trace || [], "Teacher review completed");
    notifyAssessmentChanged(action, state.current.id);
    await loadQueue();
    renderStudentFeedback();
    announceAppStatus(
      action === "approve"
        ? "Assessment approved and published to the student."
        : action === "override"
          ? "Teacher override published successfully."
          : "Assessment edits saved successfully."
    );
    if (action === "approve") {
      showView("teacher");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    renderAssessment(state.current);
  } catch (error) {
    if (error.status === 409) {
      await loadQueue({ showLoading: false });
      errorBox.textContent = "This assessment changed in another session. Reopen the latest version before saving.";
    } else {
      errorBox.textContent = error.message;
    }
    announceAppStatus(errorBox.textContent, "error");
  }
}

$("#assessment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = $("#form-error");
  const button = $("#evaluate-button");
  errorBox.textContent = "";
  if (!state.submissionConfirmed) {
    openSubmissionConfirmation();
    return;
  }
  state.submissionConfirmed = false;
  button.disabled = true;
  const inspectorAllowed = hasRole("owner", "admin");
  if (inspectorAllowed) $("#loading-overlay").classList.remove("hidden");
  const traceTimer = inspectorAllowed ? startLiveTrace() : null;
  let runContext = {};
  let completedAssessment = null;
  try {
    const homework = selectedHomework();
    const submissionType = $("#submission-type").value;
    if (!homework) throw new Error("Select an assigned homework.");
    if (!submissionType) throw new Error("Select a submission format.");
    runContext = {
      assignment: homework.title,
      module: state.modules.find((module) => module.id === homework.module_id)?.title || "",
    };

    let attachment = null;
    let attachments = [];
    let submission = "";
    let localVideoEvidence = null;
    const mcqAnswers = {};

    if (submissionType === "handwritten_image" || submissionType === "handwritten_pdf") {
      const files = [...$("#submission-file").files];
      if (!files.length) throw new Error("Upload the handwritten homework file.");
      if (files.length > 8) throw new Error("Upload no more than eight handwritten files.");
      if (files.some((file) => file.size > 10_000_000)) {
        throw new Error("Each homework file must be 10 MB or smaller.");
      }
      attachments = await Promise.all(files.map(async (file) => ({
          file_name: file.name,
          mime_type: file.type,
          size_bytes: file.size,
          data_url: await fileToDataUrl(file),
      })));
    } else if (submissionType === "mcq") {
      for (const question of homework.mcq_questions) {
        const selected = document.querySelector(`input[name="mcq-${question.id}"]:checked`);
        if (!selected) throw new Error("Answer every MCQ before submitting.");
        mcqAnswers[question.id] = Number(selected.value);
      }
    } else if (submissionType === "video_and_handnote") {
      const video = state.recordedVideo || $("#submission-file").files[0];
      if (!video) throw new Error("Select an existing video or record one in the portal.");
      const localVideo = await uploadLocalVideo(video);
      submission = localVideo.transcription.transcript;
      localVideoEvidence = buildLocalVideoEvidence(localVideo.transcription);
      $("#local-video-status").insertAdjacentHTML(
        "beforeend",
        `<small>Local Whisper transcription complete · ${escapeHtml(localVideo.transcription.language || "language auto-detected")} · ${localVideoEvidence.duration_seconds.toFixed(1)} seconds · ${localVideoEvidence.transcript_word_count} words · approximately ${localVideoEvidence.estimated_words_per_minute.toFixed(1)} words/minute.</small>`
      );
    }

    const payload = {
      homework_id: homework.id,
      student_name: state.student?.student_name || "Registered student",
      student_id: state.student?.id || "",
      assignment_title: homework.title,
      assignment_prompt: homework.instructions,
      submission_type: submissionType,
      permission_confirmed: $("#permission-confirmed").checked,
      external_media_processing_confirmed: submissionType === "video_and_handnote",
      media_processing_reference: $("#media-processing-reference").value.trim(),
      local_video_evidence: localVideoEvidence,
      submission,
      attachment,
      attachments,
      mcq_answers: mcqAnswers,
      rubric: homework.rubric,
    };
    const assessment = await api("/api/assessments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    completedAssessment = assessment;
    await loadQueue();
    state.current = assessment;
    clearStartedHomework(homework.id);
    if (!assessment.result) {
      $("#submission-message").textContent = "Homework submitted successfully. The assessment is now waiting for educator review.";
      $("#submission-message").classList.remove("hidden");
      announceAppStatus("Homework submitted successfully for educator review.");
      event.target.reset();
      renderSelectedFiles();
      renderSubmissionChoices();
      renderStudentAssignments();
      updateConsentStatus();
      renderHomeworkBrief();
      return;
    }
    const completedRun = assessmentRun(assessment);
    state.agentRuns = [
      completedRun,
      ...state.agentRuns.filter((run) => run.id !== completedRun.id),
    ].slice(0, 20);
    saveAgentRuns();
    renderAgentRunHistory();
    renderTrace(
      assessment.execution_trace || [],
      "Last run successful · Draft assessment completed",
      "success"
    );
    const completedRationale = assessmentRationaleData(assessment);
    $("#trace-rationale").innerHTML = rationaleMarkup(completedRationale);
    $("#live-inspector-events").innerHTML = traceMarkup(
      (assessment.execution_trace || []).map((item) => ({ ...item, run_state: "completed" }))
    );
    $("#live-inspector-rationale").innerHTML = rationaleMarkup(completedRationale);
    $("#live-inspector-rationale").classList.remove("hidden");
    $("#live-inspector-status").textContent = "Assessment completed · Review the evidence and rationale below";
    $(".live-inspector-summary .loader").classList.add("hidden");
    $("#close-live-inspector").classList.remove("hidden");
    $("#submission-message").textContent = attachments.length
      ? `${attachments.length} ${attachments.length === 1 ? "document was" : "documents were"} submitted successfully. Your files are shown below while the AI draft is held for educator review.`
      : "Homework submitted successfully. The AI draft is held for educator review.";
    $("#submission-message").classList.remove("hidden");
    announceAppStatus("Homework submitted successfully for educator review.");
    event.target.reset();
    renderSelectedFiles();
    renderSubmissionChoices();
    renderStudentAssignments();
    updateConsentStatus();
    renderHomeworkBrief();
  } catch (error) {
    errorBox.textContent = error.message;
    recordAgentError(error, runContext);
    announceAppStatus(error.message, "error");
  } finally {
    if (traceTimer) clearInterval(traceTimer);
    state.agentTraceActive = false;
    button.disabled = false;
    if (!completedAssessment || !completedAssessment.result) $("#loading-overlay").classList.add("hidden");
  }
});

function closeLiveInspector() {
  $("#loading-overlay").classList.add("hidden");
}

$("#close-live-inspector").addEventListener("click", closeLiveInspector);
$("#close-live-inspector-top").addEventListener("click", closeLiveInspector);

$("#refresh-queue").addEventListener("click", async () => {
  const refreshed = await loadQueue();
  announceAppStatus(
    refreshed ? "Assessment records refreshed." : "Assessment refresh failed.",
    refreshed ? "success" : "error"
  );
});
$("#back-to-queue").addEventListener("click", () => showView("teacher"));
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.dataset.view === "teacher") {
      await loadQueue();
      await loadModules();
      await loadHomeworks();
      focusNewestPendingReview();
    }
    if (button.dataset.view === "admin") await loadModules();
    if (button.dataset.view === "student") {
      requireStudentRegistration();
      await loadHomeworks();
    }
    showView(button.dataset.view);
  });
});
document.querySelectorAll(".home-view-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const view = button.dataset.openView;
    if (view === "teacher") {
      await loadQueue();
      await loadModules();
      await loadHomeworks();
      focusNewestPendingReview();
    }
    if (view === "student") {
      requireStudentRegistration();
      await loadHomeworks();
    }
    showView(view);
  });
});
document.querySelectorAll("[data-student-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.getElementById(button.dataset.studentTarget);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
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
    announceAppStatus("Learning module added successfully.");
  } catch (error) {
    errorBox.textContent = error.message;
    announceAppStatus(error.message, "error");
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
$("#teacher-class-select").addEventListener("change", () => {
  $("#teacher-subject-select").value = "";
  $("#teacher-module-select").value = "";
  populateTeacherSubjects();
});
$("#teacher-subject-select").addEventListener("change", () => {
  $("#teacher-module-select").value = "";
  renderTeacherModules();
});
$("#teacher-edit-rubric").addEventListener("click", () => {
  const moduleId = $("#teacher-module-select").value;
  if (moduleId) openRubricEditor(moduleId);
});
$("#close-rubric-editor").addEventListener("click", () => {
  $("#rubric-overlay").classList.add("hidden");
});
$("#close-module-detail").addEventListener("click", () => {
  $("#module-detail-overlay").classList.add("hidden");
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
    announceAppStatus("Assessment parameters saved successfully.");
  } catch (error) {
    errorBox.textContent = error.message;
    announceAppStatus(error.message, "error");
  }
});

$("#homework-select").addEventListener("change", () => {
  renderHomeworkBrief();
  renderSubmissionChoices();
  configureSubmissionMode();
});
$("#student-testing-class").addEventListener("change", () => {
  $("#student-testing-module").value = "__all__";
  populateStudentTestingFilters();
  $("#homework-select").value = "";
  renderHomeworkBrief();
  renderSubmissionChoices();
  configureSubmissionMode();
  renderStudentAssignments();
});
$("#student-testing-module").addEventListener("change", () => {
  $("#homework-select").value = "";
  renderHomeworkBrief();
  renderSubmissionChoices();
  configureSubmissionMode();
  renderStudentAssignments();
});

function selectSubmissionType(type) {
  $("#submission-type").value = type;
  configureSubmissionMode();
  const isVideo = type === "video_and_handnote";
  if (!isVideo) return;
  if (!state.student) {
    $("#registration-overlay").classList.remove("hidden");
    $("#submission-type").value = "";
    configureSubmissionMode();
    return;
  }
  if (!state.student.video_processing_approved) {
    $("#form-error").textContent = "Video upload is disabled because it was not approved during parent consent registration.";
    $("#submission-type").value = "";
    configureSubmissionMode();
  }
}

document.querySelectorAll(".submission-choice").forEach((choice) => {
  choice.addEventListener("click", () => selectSubmissionType(choice.dataset.submissionType));
});
$("#submission-file").addEventListener("change", renderSelectedFiles);
$("#submission-file").addEventListener("change", () => {
  if ($("#submission-file").files.length) markSelectedHomeworkStarted();
});
$("#permission-confirmed").addEventListener("change", updateSubmissionJourney);
$("#close-submission-confirmation").addEventListener("click", closeSubmissionConfirmation);
$("#cancel-submission-confirmation").addEventListener("click", closeSubmissionConfirmation);
$("#submission-confirmation-overlay").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeSubmissionConfirmation();
});
$("#confirm-final-submission").addEventListener("click", () => {
  state.submissionConfirmed = true;
  closeSubmissionConfirmation();
  $("#assessment-form").requestSubmit();
});

$("#start-recording").addEventListener("click", async () => {
  try {
    markSelectedHomeworkStarted();
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
      $("#save-recording").classList.remove("hidden");
      $("#recording-status").textContent = "Recording ready. Save a personal copy or submit it to the local web app.";
      state.recordingStream.getTracks().forEach((track) => track.stop());
      state.recordingStream = null;
      updateSubmissionJourney();
    });
    state.mediaRecorder.start();
    $("#start-recording").disabled = true;
    $("#stop-recording").disabled = false;
    $("#recording-status").textContent = "Recording in progress...";
  } catch (error) {
    $("#form-error").textContent = `Camera or microphone access failed: ${error.message}`;
  }
});

$("#save-recording").addEventListener("click", () => {
  if (!state.recordedVideo) return;
  const url = URL.createObjectURL(state.recordedVideo);
  const link = document.createElement("a");
  link.href = url;
  link.download = state.recordedVideo.name;
  link.click();
  URL.revokeObjectURL(url);
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
  const learnerType = $("#learner-type").value;
  if (!state.verification.student.token ||
      (learnerType === "minor" && !state.verification.parent.token)) {
    errorBox.textContent = learnerType === "minor"
      ? "Verify both student and parent email addresses before registration."
      : "Verify the adult learner email before registration.";
    return;
  }
  try {
    const profile = await api("/api/students/register", {
      method: "POST",
      body: JSON.stringify({
        student_name: $("#register-student-name").value.trim(),
        student_email: $("#register-student-email").value.trim(),
        learner_type: learnerType,
        grade_level: $("#register-class").value,
        parent_name: $("#parent-name").value.trim(),
        parent_email: $("#parent-email").value.trim(),
        parent_consent_confirmed: $("#registration-parent-consent").checked,
        self_consent_confirmed: $("#registration-self-consent").checked,
        video_processing_approved: $("#registration-video-consent").checked,
        student_email_verification_token: state.verification.student.token,
        parent_email_verification_token: state.verification.parent.token || "",
      }),
    });

    localStorage.setItem("edugrade_student", JSON.stringify(profile));
    state.student = profile;
    updateConsentStatus();
    await loadStudents();
    await loadHomeworks();
    $("#registration-overlay").classList.add("hidden");
    announceAppStatus("Registration completed successfully.");
  } catch (error) {
    errorBox.textContent = error.message;
    announceAppStatus(error.message, "error");
  }
});

$("#close-registration").addEventListener("click", closeRegistration);
$("#registration-overlay").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeRegistration();
});
document.addEventListener("keydown", (event) => {
  const activeDialog = [...document.querySelectorAll(
    "#loading-overlay, #module-detail-overlay, #submission-confirmation-overlay, #rubric-overlay, #registration-overlay"
  )].find((overlay) => !overlay.classList.contains("hidden"));
  if (!activeDialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (activeDialog.id === "loading-overlay") closeLiveInspector();
    else if (activeDialog.id === "registration-overlay") closeRegistration();
    else if (activeDialog.id === "submission-confirmation-overlay") closeSubmissionConfirmation();
    else activeDialog.classList.add("hidden");
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...activeDialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.classList.contains("hidden") && element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

let lastDialogTrigger = null;
const dialogObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    const overlay = mutation.target;
    if (!overlay.classList.contains("hidden")) {
      lastDialogTrigger = document.activeElement;
      requestAnimationFrame(() => {
        overlay.querySelector(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )?.focus();
      });
    } else if (lastDialogTrigger instanceof HTMLElement && document.contains(lastDialogTrigger)) {
      lastDialogTrigger.focus();
      lastDialogTrigger = null;
    }
  });
});
document.querySelectorAll(
  "#loading-overlay, #module-detail-overlay, #submission-confirmation-overlay, #rubric-overlay, #registration-overlay"
).forEach((overlay) => dialogObserver.observe(overlay, { attributes: true, attributeFilter: ["class"] }));

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
$("#learner-type").addEventListener("change", () => {
  const adult = $("#learner-type").value === "adult_trainee";
  $("#parent-consent-fields").classList.toggle("hidden", adult);
  $("#self-consent-row").classList.toggle("hidden", !adult);
  $("#parent-name").required = !adult;
  $("#parent-email").required = !adult;
  $("#registration-parent-consent").required = !adult;
  $("#registration-self-consent").required = adult;
  if (adult && [...$("#register-class").options].some((option) => option.value === "Teacher Training")) {
    $("#register-class").value = "Teacher Training";
  }
});

$("#trace-toggle").addEventListener("click", () => {
  $("#trace-panel").classList.toggle("collapsed");
  document.body.classList.toggle(
    "trace-open",
    !$("#trace-panel").classList.contains("collapsed")
  );
  if (!$("#trace-panel").classList.contains("collapsed") && !state.agentTraceActive) {
    showAgentRun(state.agentRuns[0]?.id);
  }
});
$("#trace-last-run").addEventListener("click", () => {
  $("#trace-history-list").classList.add("hidden");
  showAgentRun(state.agentRuns[0]?.id);
});
$("#trace-history-toggle").addEventListener("click", () => {
  $("#trace-history-list").classList.toggle("hidden");
});
$("#trace-collapse").addEventListener("click", () => {
  $("#trace-panel").classList.add("collapsed");
  document.body.classList.remove("trace-open");
});

async function initializeApp() {
  state.student = getStoredStudent();
  try {
    await loadSession();
    await loadOwnedStudentProfile();
  } catch (error) {
    announceAppStatus(`Sign-in session could not be loaded: ${error.message}`, "error");
    applyRoleNavigation();
  }
  renderAgentRunHistory();
  updateConsentStatus();
  checkHealth();
  const initialLoads = [loadQueue(), loadModules(), loadHomeworks()];
  if (hasRole("teacher", "admin")) initialLoads.push(loadStudents());
  await Promise.allSettled(initialLoads);
}

initializeApp();

let sharedRefreshInFlight = false;
async function refreshSharedAssessmentState() {
  if (sharedRefreshInFlight || document.hidden || state.agentTraceActive) return;
  sharedRefreshInFlight = true;
  try {
    await loadQueue({ showLoading: false });
  } finally {
    sharedRefreshInFlight = false;
  }
}
setInterval(refreshSharedAssessmentState, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshSharedAssessmentState();
});
assessmentChannel?.addEventListener("message", refreshSharedAssessmentState);
