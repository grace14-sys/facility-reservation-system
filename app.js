// ===============================
// SUPABASE CONFIGURATION
// ===============================
// 1. Create a Supabase project.
// 2. Run supabase.sql in Supabase SQL Editor.
// 3. Put your project URL and anon public key below.
// Do NOT put a service_role key in this file.

const SUPABASE_URL = "https://tvgnfshangtmeoumqyse.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_g4KSbGYOrBNURj7RZO49Jg_pP2tjISr";

const configured = !SUPABASE_URL.includes("PASTE_") && !SUPABASE_ANON_KEY.includes("PASTE_");
const sb = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

let currentUser = null;
let currentProfile = null;

const $ = (id) => document.getElementById(id);

function showMessage(text, type="success") {
  const box = $("message");
  box.textContent = text;
  box.className = `message show ${type}`;
  setTimeout(() => box.className = "message", 4000);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "";
}

function statusClass(status) {
  return String(status || "").toLowerCase().replace(/\s+/g,"-");
}

async function getProfile() {
  if (!sb || !currentUser) return;
  const { data, error } = await sb.from("profiles").select("*").eq("id", currentUser.id).single();
  if (error) throw error;
  currentProfile = data;
}

async function loadFacilities() {
  const { data, error } = await sb.from("facilities").select("*").order("facility_name");
  if (error) return showMessage(error.message, "error");

  $("facilityList").innerHTML = data.map(f => `
    <div class="facility">
      <h3>${escapeHtml(f.facility_name)}</h3>
      <p><strong>Location:</strong> ${escapeHtml(f.location)}</p>
      <p><strong>Condition:</strong> ${escapeHtml(f.condition)}</p>
      <p class="status ${statusClass(f.status)}-status"><strong>Status:</strong> ${escapeHtml(f.status)}</p>
    </div>
  `).join("") || "<p>No facilities found.</p>";

  const active = data.filter(f => f.status === "Active");
  $("facilitySelect").innerHTML = active.map(f =>
    `<option value="${f.id}">${escapeHtml(f.facility_name)} - ${escapeHtml(f.location)}</option>`
  ).join("");
}

async function loadReservations() {
  const { data, error } = await sb.from("reservations")
    .select("id,start_time,end_time,purpose,status,created_at,requester:profiles!reservations_requester_id_fkey(full_name,email),facility:facilities!reservations_facility_id_fkey(facility_name)")
    .order("start_time", { ascending:false });

  if (error) return showMessage(error.message, "error");

  const rows = currentProfile.role === "Requester"
    ? data.filter(r => r.requester && r.requester.email === currentUser.email)
    : data;

  $("reservationList").innerHTML = makeReservationTable(rows, currentProfile.role === "Requester");
  if (currentProfile.role === "Administrator") $("adminReservations").innerHTML = makeAdminTable(data);
  if (currentProfile.role === "Facility Staff") $("staffReservations").innerHTML = makeStaffTable(data);
}

function makeReservationTable(rows, requesterView=false) {
  if (!rows.length) return "<p>No reservations found.</p>";
  return `<div class="table-wrap"><table><tr><th>Facility</th><th>Requester</th><th>Schedule</th><th>Purpose</th><th>Status</th><th>Action</th></tr>
    ${rows.map(r => `
      <tr>
        <td>${escapeHtml(r.facility?.facility_name)}</td>
        <td>${escapeHtml(r.requester?.full_name || r.requester?.email)}</td>
        <td>${formatDate(r.start_time)}<br>to<br>${formatDate(r.end_time)}</td>
        <td>${escapeHtml(r.purpose)}</td>
        <td><strong>${escapeHtml(r.status)}</strong></td>
        <td>${requesterView && r.status === "Pending" ? `<button class="danger" onclick="cancelReservation('${r.id}')">Cancel</button>` : "—"}</td>
      </tr>`).join("")}
  </table></div>`;
}

function makeAdminTable(rows) {
  const pending = rows.filter(r => r.status === "Pending");
  if (!pending.length) return "<p>No pending reservations.</p>";
  return makeActionTable(pending, "admin");
}

function makeStaffTable(rows) {
  const usable = rows.filter(r => ["Approved","Scheduled","In Use"].includes(r.status));
  if (!usable.length) return "<p>No reservations need staff action.</p>";
  return makeActionTable(usable, "staff");
}

function makeActionTable(rows, mode) {
  return `<div class="table-wrap"><table><tr><th>Facility</th><th>Requester</th><th>Schedule</th><th>Status</th><th>Actions</th></tr>
  ${rows.map(r => {
    let actions = "";
    if (mode === "admin" && r.status === "Pending") {
      actions = `<button class="success" onclick="approveReservation('${r.id}')">Approve</button>
                 <button class="danger" onclick="rejectReservation('${r.id}')">Reject</button>`;
    }
    if (mode === "staff") {
      if (r.status === "Approved" || r.status === "Scheduled") actions += `<button onclick="setReservationStatus('${r.id}','In Use')">In Use</button>`;
      if (r.status === "In Use") actions += `<button class="success" onclick="setReservationStatus('${r.id}','Completed')">Complete</button>`;
    }
    return `<tr><td>${escapeHtml(r.facility?.facility_name)}</td>
      <td>${escapeHtml(r.requester?.full_name || r.requester?.email)}</td>
      <td>${formatDate(r.start_time)}<br>to<br>${formatDate(r.end_time)}</td>
      <td>${escapeHtml(r.status)}</td><td><div class="actions">${actions}</div></td></tr>`;
  }).join("")}</table></div>`;
}

async function loadAudit() {
  if (currentProfile.role !== "Administrator") {
    $("auditList").innerHTML = "<p>Audit logs are available to Administrators only.</p>";
    return;
  }
  const { data, error } = await sb.from("audit_logs")
    .select("id,action,old_status,new_status,created_at,user:profiles!audit_logs_user_id_fkey(full_name,email),reservation:reservations!audit_logs_reservation_id_fkey(id)")
    .order("created_at", { ascending:false }).limit(100);
  if (error) return showMessage(error.message, "error");
  $("auditList").innerHTML = data.length ? `<div class="table-wrap"><table><tr><th>User</th><th>Action</th><th>Old Status</th><th>New Status</th><th>Timestamp</th></tr>
    ${data.map(a => `<tr><td>${escapeHtml(a.user?.full_name || a.user?.email)}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.old_status || "—")}</td><td>${escapeHtml(a.new_status || "—")}</td><td>${formatDate(a.created_at)}</td></tr>`).join("")}</table></div>` : "<p>No audit logs yet.</p>";
}

async function refreshAll() {
  await loadFacilities();
  await loadReservations();
  await loadAudit();
}

async function login(e) {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({
    email: $("loginEmail").value.trim(),
    password: $("loginPassword").value
  });
  if (error) return showMessage(error.message, "error");
  showMessage("Login successful.");
}

async function signup(e) {
  e.preventDefault();
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;
  const name = $("signupName").value.trim();
  const { error } = await sb.auth.signUp({
    email, password, options:{ data:{ full_name:name } }
  });
  if (error) return showMessage(error.message, "error");
  showMessage("Account created. If email confirmation is enabled, confirm your email before logging in.");
}

async function submitReservation(e) {
  e.preventDefault();
  const start = $("startTime").value;
  const end = $("endTime").value;
  if (new Date(start) >= new Date(end)) return showMessage("Start time must be before end time.", "error");

  const { data, error } = await sb.rpc("submit_reservation", {
    p_facility_id: $("facilitySelect").value,
    p_start_time: new Date(start).toISOString(),
    p_end_time: new Date(end).toISOString(),
    p_purpose: $("purpose").value.trim()
  });
  if (error) return showMessage(error.message, "error");
  showMessage(`Reservation submitted: ${data.status}`);
  $("reservationForm").reset();
  await refreshAll();
}

window.cancelReservation = async (id) => {
  const { error } = await sb.rpc("cancel_reservation", { p_reservation_id:id });
  if (error) return showMessage(error.message, "error");
  showMessage("Reservation cancelled.");
  await refreshAll();
};

window.approveReservation = async (id) => {
  const { error } = await sb.rpc("admin_set_reservation_status", { p_reservation_id:id, p_new_status:"Approved" });
  if (error) return showMessage(error.message, "error");
  showMessage("Reservation approved.");
  await refreshAll();
};

window.rejectReservation = async (id) => {
  const { error } = await sb.rpc("admin_set_reservation_status", { p_reservation_id:id, p_new_status:"Rejected" });
  if (error) return showMessage(error.message, "error");
  showMessage("Reservation rejected.");
  await refreshAll();
};

window.setReservationStatus = async (id, status) => {
  const { error } = await sb.rpc("staff_set_reservation_status", { p_reservation_id:id, p_new_status:status });
  if (error) return showMessage(error.message, "error");
  showMessage(`Reservation changed to ${status}.`);
  await refreshAll();
};

async function addFacility(e) {
  e.preventDefault();
  const { error } = await sb.from("facilities").insert({
    facility_name:$("facilityName").value.trim(),
    location:$("facilityLocation").value.trim(),
    status:$("facilityStatus").value,
    condition:$("facilityCondition").value.trim()
  });
  if (error) return showMessage(error.message, "error");
  showMessage("Facility added.");
  e.target.reset();
  await loadFacilities();
}

function showDashboard() {
  $("authSection").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
  $("logoutBtn").classList.remove("hidden");
  $("userName").textContent = currentProfile.full_name || currentUser.email;
  $("roleBadge").textContent = currentProfile.role;

  $("adminPanel").classList.toggle("hidden", currentProfile.role !== "Administrator");
  $("staffPanel").classList.toggle("hidden", currentProfile.role !== "Facility Staff");
  $("noManagePanel").classList.toggle("hidden", !["Administrator","Facility Staff"].includes(currentProfile.role));
  $("auditTab").classList.remove("hidden");
}

async function initUser() {
  if (!sb) return;
  const { data:{ user } } = await sb.auth.getUser();
  currentUser = user;
  if (!user) {
    $("authSection").classList.remove("hidden");
    $("dashboard").classList.add("hidden");
    $("logoutBtn").classList.add("hidden");
    return;
  }
  try {
    await getProfile();
    showDashboard();
    await refreshAll();
  } catch (err) {
    showMessage(err.message || "Could not load profile.", "error");
  }
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.add("active");
  }));
}

document.addEventListener("DOMContentLoaded", async () => {
  if (!configured) {
    $("setupNotice").classList.remove("hidden");
    return;
  }

  $("loginForm").addEventListener("submit", login);
  $("signupForm").addEventListener("submit", signup);
  $("reservationForm").addEventListener("submit", submitReservation);
  $("facilityForm").addEventListener("submit", addFacility);
  $("logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); showMessage("Logged out."); });
  $("refreshFacilities").addEventListener("click", loadFacilities);
  $("refreshReservations").addEventListener("click", loadReservations);
  $("refreshAudit").addEventListener("click", loadAudit);
  wireTabs();

  sb.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    if (currentUser) await initUser();
    else {
      $("authSection").classList.remove("hidden");
      $("dashboard").classList.add("hidden");
      $("logoutBtn").classList.add("hidden");
    }
  });

  await initUser();
});
