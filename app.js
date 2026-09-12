// Supabase Configuration
const SUPABASE_URL = 'https://hbqslsbwqntsmunvyojl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhicXNsc2J3cW50c211bnZ5b2psIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMjAzOTAsImV4cCI6MjEwNDc5NjM5MH0.3jQlkKrlIRFwYS9_1s5jbRh_7PlwNo_0fxfqLtGGziI';

const dbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper to decode Google JWT ID Token
function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      window.atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.error("Failed to parse JWT", e);
    return null;
  }
}

// UI session handler
function displayUserSession(user) {
  if (!user) return;
  document.getElementById('userNameDisplay').textContent = user.name || 'Clinician';
  document.getElementById('userEmailDisplay').textContent = user.email || '';
  
  const avatar = document.getElementById('userAvatar');
  if (user.picture) {
    avatar.src = user.picture;
    avatar.classList.remove('d-none');
  } else {
    avatar.classList.add('d-none');
  }

  document.getElementById('loginLandingSection').classList.add('d-none');
  document.getElementById('mainAppSection').classList.remove('d-none');
}

// Global Google Auth Callback
window.handleCredentialResponse = async function(response) {
  const payload = parseJwt(response.credential);
  if (payload) {
    const user = { name: payload.name, email: payload.email, picture: payload.picture };
    localStorage.setItem('clinixUser', JSON.stringify(user));
    displayUserSession(user);
  }

  // Authenticate with Supabase so Row Level Security policies apply
  await dbClient.auth.signInWithIdToken({
    provider: 'google',
    token: response.credential,
  });

  if (window.refreshAppLogs) {
    await window.refreshAppLogs();
  }
};

// Global Logout Handler
window.logoutUser = async function() {
  await dbClient.auth.signOut();
  localStorage.removeItem('clinixUser');
  document.getElementById('mainAppSection').classList.add('d-none');
  document.getElementById('loginLandingSection').classList.remove('d-none');
};

document.addEventListener('DOMContentLoaded', async () => {
  const savedUser = JSON.parse(localStorage.getItem('clinixUser'));
  if (savedUser) {
    displayUserSession(savedUser);
  }

  const prescriptionModal = new bootstrap.Modal(document.getElementById('prescriptionModal'));
  const billingModal = new bootstrap.Modal(document.getElementById('billingModal'));
  const viewRecordModal = new bootstrap.Modal(document.getElementById('viewRecordModal'));
  const editRecordModal = new bootstrap.Modal(document.getElementById('editRecordModal'));

  let logs = [];
  let currentActiveView = 'view-ehr';

  // Metric Range & Risk Evaluator
  const evaluateRisk = (metric, valStr) => {
    const val = parseFloat(valStr);

    // Weight has no status/badge
    if (metric === 'Weight') {
      return { status: '', class: '' };
    }

    // SpO2 (%)
    if (metric === 'SpO2') {
      if (isNaN(val) || val < 90 || val > 100) return { status: 'Critical', class: 'badge-soft-danger' };
      if (val <= 94) return { status: 'Risk', class: 'badge-soft-warning' };
      return { status: 'Normal', class: 'badge-soft-success' };
    }

    // Heart Rate (bpm)
    if (metric === 'Heart Rate') {
      if (isNaN(val) || val < 50 || val > 120) return { status: 'Critical', class: 'badge-soft-danger' };
      if (val < 60 || val > 100) return { status: 'Risk', class: 'badge-soft-warning' };
      return { status: 'Normal', class: 'badge-soft-success' };
    }

    // Blood Pressure (mmHg)
    if (metric === 'Blood Pressure') {
      const parts = valStr.split('/');
      if (parts.length >= 2) {
        const sys = parseInt(parts[0], 10);
        const dia = parseInt(parts[1], 10);
        if (isNaN(sys) || isNaN(dia)) return { status: 'Normal', class: 'badge-soft-success' };

        if (sys >= 160 || dia >= 100 || sys < 90 || dia < 60) return { status: 'Critical', class: 'badge-soft-danger' };
        if (sys >= 120 || dia >= 80) return { status: 'Risk', class: 'badge-soft-warning' };
        return { status: 'Normal', class: 'badge-soft-success' };
      }
    }

    // Blood Sugar (mg/dL)
    if (metric === 'Blood Sugar') {
      if (isNaN(val) || val < 60 || val > 200) return { status: 'Critical', class: 'badge-soft-danger' };
      if (val < 70 || val > 140) return { status: 'Risk', class: 'badge-soft-warning' };
      return { status: 'Normal', class: 'badge-soft-success' };
    }

    // Body Temp (°C)
    if (metric === 'Body Temp') {
      if (isNaN(val) || val < 35.5 || val > 38.5) return { status: 'Critical', class: 'badge-soft-danger' };
      if (val < 36.5 || val > 37.5) return { status: 'Risk', class: 'badge-soft-warning' };
      return { status: 'Normal', class: 'badge-soft-success' };
    }

    // Respiratory Rate (breaths/min)
    if (metric === 'Respiratory Rate') {
      if (isNaN(val) || val < 9 || val > 24) return { status: 'Critical', class: 'badge-soft-danger' };
      if (val < 12 || val > 20) return { status: 'Risk', class: 'badge-soft-warning' };
      return { status: 'Normal', class: 'badge-soft-success' };
    }

    return { status: 'Normal', class: 'badge-soft-success' };
  };

  // Fetch logs from Supabase
  async function fetchLogs() {
    const { data, error } = await dbClient
      .from('health_logs')
      .select('*')
      .order('date', { ascending: false });

    if (error) {
      console.error('Error fetching logs from Supabase:', error.message);
      return [];
    }

    return data.map(item => ({
      id: item.id,
      patient: item.patient,
      loggedBy: item.logged_by,
      metric: item.metric,
      context: item.context,
      value: item.value,
      notes: item.notes,
      status: item.status,
      statusClass: item.status_class,
      reviewed: item.reviewed,
      date: item.date
    }));
  }

  window.refreshAppLogs = async () => {
    logs = await fetchLogs();
    updateAllTables();
  };

  const form = document.getElementById('logForm');
  const editForm = document.getElementById('editLogForm');
  
  const ehrTableBody = document.getElementById('ehrTableBody');
  const rxTableBody = document.getElementById('rxTableBody');
  const billingTableBody = document.getElementById('billingTableBody');
  
  const searchEHR = document.getElementById('searchEHR');
  const searchRx = document.getElementById('searchRx');
  const dateRx = document.getElementById('dateRx');
  const searchBill = document.getElementById('searchBill');
  const dateBill = document.getElementById('dateBill');

  const metricUnits = {
    'Heart Rate': 'bpm',
    'Blood Pressure': 'mmHg',
    'Blood Sugar': 'mg/dL',
    'Weight': 'kg',
    'SpO2': '%',
    'Body Temp': '°C',
    'Respiratory Rate': 'breaths/min'
  };

  // Theme Handling
  const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-bs-theme', theme);
    document.getElementById('themeIcon').className = theme === 'dark' ? 'bi bi-sun-fill me-1' : 'bi bi-moon-stars-fill me-1';
    document.getElementById('themeText').textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  };
  applyTheme(localStorage.getItem('theme') || 'light');
  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const newTheme = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', newTheme);
    applyTheme(newTheme);
  });

  // Sidebar Navigation Logic
  document.querySelectorAll('.nav-item[data-target]').forEach(link => {
    link.addEventListener('click', (e) => {
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      e.currentTarget.classList.add('active');
      
      const targetId = e.currentTarget.getAttribute('data-target');
      currentActiveView = targetId;

      document.querySelectorAll('.view-section').forEach(sec => sec.classList.add('d-none'));
      document.getElementById(targetId).classList.remove('d-none');

      const titles = { 'view-ehr': 'Patient Records (EHR)', 'view-rx': 'Prescription Management', 'view-billing': 'Medical Billing' };
      document.getElementById('currentViewTitle').textContent = titles[targetId];
    });
  });

  const updateAllTables = () => {
    renderEHRTable(); renderRxTable(); renderBillTable(); renderTriageQueue(); updatePatientSuggestions();
  };

  const updatePatientSuggestions = () => {
    const uniquePatients = [...new Set(logs.map(l => l.patient))];
    document.getElementById('patientSuggestions').innerHTML = uniquePatients.map(p => `<option value="${p}">`).join('');
  };

  // Rendering EHR Table
  const renderEHRTable = () => {
    const searchTerm = searchEHR.value.toLowerCase();
    const ehrLogs = logs.filter(l => l.metric !== 'Prescription' && l.metric !== 'Bill' && 
      (l.patient.toLowerCase().includes(searchTerm) || l.metric.toLowerCase().includes(searchTerm)));

    ehrTableBody.innerHTML = ehrLogs.length === 0 ? `<tr><td colspan="6" class="text-center text-muted">No clinical records found.</td></tr>` : 
      ehrLogs.map(log => {
        const unit = metricUnits[log.metric] || '';
        const statusBadge = log.status ? `<span class="badge ${log.statusClass} rounded-pill px-3">${log.status}</span>` : '-';
        return `
        <tr>
          <td class="fw-bold text-primary">${log.patient} ${log.status === 'Critical' && !log.reviewed ? '<i class="bi bi-circle-fill text-danger" style="font-size:0.5rem"></i>' : ''}</td>
          <td><i class="bi bi-activity text-info"></i> ${log.metric} <br><span class="badge badge-soft-info" style="font-size: 0.65rem;">${log.context || '-'}</span></td>
          <td class="fw-bold">${log.value} <span class="text-muted fw-normal" style="font-size: 0.8rem;">${unit}</span></td>
          <td>${statusBadge}</td>
          <td class="text-muted small">${new Date(log.date).toLocaleDateString()}<br><i class="bi bi-person me-1"></i>${log.loggedBy}</td>
          <td class="text-end no-print text-nowrap">
            <div class="action-btn-group">
              <button class="btn btn-sm btn-light text-primary" onclick="viewLog('${log.id}')" title="View"><i class="bi bi-eye"></i></button>
              <button class="btn btn-sm btn-light text-warning" onclick="editLog('${log.id}')" title="Edit"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-light text-danger" onclick="deleteLog('${log.id}')" title="Delete"><i class="bi bi-trash"></i></button>
            </div>
          </td>
        </tr>
      `}).join('');
  };

  // View Log Modal
  window.viewLog = (id) => {
    const log = logs.find(l => l.id === id);
    if (!log) return;
    const unit = metricUnits[log.metric] || '';
    const statusDisplay = log.status ? `<span class="badge ${log.statusClass}">${log.status}</span>` : 'N/A';
    document.getElementById('viewRecordContent').innerHTML = `
      <div class="mb-3"><span class="text-muted small d-block">Patient Name</span><strong class="fs-5">${log.patient}</strong></div>
      <div class="row mb-3">
        <div class="col-6"><span class="text-muted small d-block">Metric</span><strong>${log.metric}</strong></div>
        <div class="col-6"><span class="text-muted small d-block">Value</span><strong class="fs-5">${log.value} ${unit}</strong></div>
      </div>
      <div class="row mb-3">
        <div class="col-6"><span class="text-muted small d-block">Context</span><strong>${log.context || 'N/A'}</strong></div>
        <div class="col-6"><span class="text-muted small d-block">Status</span>${statusDisplay}</div>
      </div>
      <div class="mb-3"><span class="text-muted small d-block">Notes</span><div class="bg-light p-2 rounded border">${log.notes || 'No notes provided.'}</div></div>
      <div class="row text-muted small border-top pt-2 mt-2">
        <div class="col-6"><i class="bi bi-person-badge"></i> ${log.loggedBy}</div>
        <div class="col-6 text-end"><i class="bi bi-calendar3"></i> ${new Date(log.date).toLocaleString()}</div>
      </div>
    `;
    viewRecordModal.show();
  };

  // Edit Log Modal
  window.editLog = (id) => {
    const log = logs.find(l => l.id === id);
    if (!log) return;
    document.getElementById('editLogId').value = log.id;
    document.getElementById('editPatientName').value = log.patient;
    document.getElementById('editStaffId').value = log.loggedBy;
    document.getElementById('editMetricType').value = log.metric;
    document.getElementById('editReadingContext').value = log.context;
    document.getElementById('editValue').value = log.value;
    document.getElementById('editNotes').value = log.notes;
    editRecordModal.show();
  };

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editLogId').value;
    const metric = document.getElementById('editMetricType').value;
    const rawValue = document.getElementById('editValue').value.trim();

    if (metric === 'Blood Pressure' && !/^\d{2,3}\/\d{2,3}$/.test(rawValue)) {
      return alert("Blood Pressure must be formatted as SYS/DIA (e.g., 120/80).");
    } else if (metric !== 'Blood Pressure' && !/^\d+(\.\d+)?$/.test(rawValue)) {
      return alert(`Please enter a valid numeric value for ${metric}.`);
    }

    const risk = evaluateRisk(metric, rawValue);
    
    const updatedRecord = {
      patient: document.getElementById('editPatientName').value.trim(),
      logged_by: document.getElementById('editStaffId').value.trim(),
      metric, 
      context: document.getElementById('editReadingContext').value,
      value: rawValue, 
      notes: document.getElementById('editNotes').value.trim(),
      status: risk.status, 
      status_class: risk.class, 
      reviewed: risk.status !== 'Critical'
    };

    const { error } = await dbClient.from('health_logs').update(updatedRecord).eq('id', id);
    if (error) {
      alert('Failed to update record: ' + error.message);
      return;
    }

    editRecordModal.hide();
    await window.refreshAppLogs();
  });

  // Render Prescriptions
  const renderRxTable = () => {
    const searchVal = searchRx.value.toLowerCase();
    const dateVal = dateRx.value;
    
    const rxLogs = logs.filter(l => {
      if (l.metric !== 'Prescription') return false;
      const matchName = l.patient.toLowerCase().includes(searchVal);
      const matchDate = dateVal ? l.date.startsWith(dateVal) : true;
      return matchName && matchDate;
    });

    rxTableBody.innerHTML = rxLogs.length === 0 ? `<tr><td colspan="5" class="text-center text-muted">No active prescriptions.</td></tr>` : 
      rxLogs.map(log => `
        <tr>
          <td class="fw-bold text-purple">${log.patient}</td>
          <td class="small">${log.value}</td>
          <td class="text-muted"><i class="bi bi-person-badge"></i> ${log.loggedBy}</td>
          <td class="small">${new Date(log.date).toLocaleDateString()}</td>
          <td class="text-end no-print text-nowrap">
            <div class="action-btn-group">
              <button class="btn btn-sm btn-light text-danger" onclick="deleteLog('${log.id}')"><i class="bi bi-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
  };

  // Render Billing
  const renderBillTable = () => {
    const searchVal = searchBill.value.toLowerCase();
    const dateVal = dateBill.value;

    const billLogs = logs.filter(l => {
      if (l.metric !== 'Bill') return false;
      const matchName = l.patient.toLowerCase().includes(searchVal);
      const matchDate = dateVal ? l.date.startsWith(dateVal) : true;
      return matchName && matchDate;
    });

    billingTableBody.innerHTML = billLogs.length === 0 ? `<tr><td colspan="5" class="text-center text-muted">No billing records found.</td></tr>` : 
      billLogs.map(log => `
        <tr>
          <td class="fw-bold text-success">${log.patient}</td>
          <td><span class="fw-bold">${log.value}</span><br><span class="text-muted small">${log.notes}</span></td>
          <td class="text-muted"><i class="bi bi-person-badge"></i> ${log.loggedBy}</td>
          <td class="small">${new Date(log.date).toLocaleDateString()}</td>
          <td class="text-end no-print text-nowrap">
            <div class="action-btn-group">
              <button class="btn btn-sm btn-light text-danger" onclick="deleteLog('${log.id}')"><i class="bi bi-trash"></i></button>
            </div>
          </td>
        </tr>
      `).join('');
  };

  // Triage Queue Logic
  const renderTriageQueue = () => {
    const triageCard = document.getElementById('triageCard');
    const criticalLogs = logs.filter(l => l.status === 'Critical' && !l.reviewed && l.metric !== 'Prescription' && l.metric !== 'Bill');
    if (criticalLogs.length === 0) { triageCard.classList.add('d-none'); return; }
    
    triageCard.classList.remove('d-none');
    document.getElementById('triageCountBadge').textContent = `${criticalLogs.length} Action(s) Required`;
    document.getElementById('triageList').innerHTML = criticalLogs.map(log => `
      <div class="triage-item p-3 d-flex justify-content-between align-items-center">
        <div><h6 class="mb-1 fw-bold"><i class="bi bi-exclamation-triangle-fill text-danger me-1"></i> ${log.patient}</h6>
        <span class="small text-muted">Critical ${log.metric}: <strong>${log.value} ${metricUnits[log.metric] || ''}</strong></span></div>
        <button class="btn btn-sm btn-success fw-semibold" onclick="clearTriage('${log.id}')">Acknowledge</button>
      </div>
    `).join('');
  };

  window.clearTriage = async (id) => {
    const { error } = await dbClient.from('health_logs').update({ reviewed: true }).eq('id', id);
    if (!error) {
      await window.refreshAppLogs();
    }
  };

  window.deleteLog = async (id) => { 
    if (confirm('Delete this record?')) { 
      const { error } = await dbClient.from('health_logs').delete().eq('id', id);
      if (!error) {
        await window.refreshAppLogs();
      }
    } 
  };

  // Form Submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const metric = document.getElementById('metricType').value;
    const rawValue = document.getElementById('value').value.trim();

    if (metric === 'Blood Pressure') {
      if (!/^\d{2,3}\/\d{2,3}$/.test(rawValue)) return alert("Blood Pressure must be formatted as SYS/DIA (e.g., 120/80).");
    } else {
      if (!/^\d+(\.\d+)?$/.test(rawValue)) return alert(`Please enter a valid numeric value for ${metric}.`);
    }

    const risk = evaluateRisk(metric, rawValue);
    
    const newRecord = {
      patient: document.getElementById('patientName').value.trim(),
      logged_by: document.getElementById('staffId').value.trim(),
      metric, 
      context: document.getElementById('readingContext').value, 
      value: rawValue, 
      notes: document.getElementById('notes').value.trim(),
      status: risk.status, 
      status_class: risk.class, 
      reviewed: risk.status !== 'Critical'
    };

    const { error } = await dbClient.from('health_logs').insert([newRecord]);
    if (error) {
      alert('Failed to save record: ' + error.message);
      return;
    }

    form.reset();
    await window.refreshAppLogs();
  });

  // Multiple Prescriptions Submit Logic
  let rxItems = [];
  document.getElementById('addRxItemBtn').addEventListener('click', () => {
    const med = document.getElementById('rxMedication').value.trim();
    const freq = document.getElementById('rxFrequency').value;
    const dur = document.getElementById('rxDuration').value;
    
    if (med && dur > 0) {
      rxItems.push({ med, freq, dur });
      document.getElementById('rxMedication').value = '';
      document.getElementById('rxDuration').value = '5';
      renderRxItems();
    }
  });

  const renderRxItems = () => {
    const tbody = document.getElementById('rxItemsList');
    tbody.innerHTML = rxItems.map((item, i) => `<tr>
      <td>${item.med}</td><td>${item.freq}</td><td>${item.dur} days</td>
      <td class="text-end"><button class="btn btn-sm text-danger p-0 m-0" onclick="removeRxItem(${i})"><i class="bi bi-x-circle"></i></button></td>
    </tr>`).join('');
  };

  window.removeRxItem = (i) => { rxItems.splice(i, 1); renderRxItems(); };

  document.getElementById('saveRxBtn').addEventListener('click', async () => {
    const patient = document.getElementById('rxPatient').value.trim();
    const doctor = document.getElementById('rxDoctor').value.trim();
    
    if (!patient || !doctor || rxItems.length === 0) return alert('Fill required fields and add at least one medication.');
    
    const valueStr = rxItems.map(i => `• ${i.med} (${i.freq} for ${i.dur} days)`).join('<br>');
    
    const newRx = {
      patient, 
      logged_by: doctor,
      metric: 'Prescription', 
      context: 'Rx', 
      value: valueStr, 
      notes: '',
      status: 'Active', 
      status_class: 'badge-soft-purple', 
      reviewed: true
    };

    const { error } = await dbClient.from('health_logs').insert([newRx]);
    if (error) {
      alert('Failed to save prescription: ' + error.message);
      return;
    }

    rxItems = []; 
    renderRxItems(); 
    document.getElementById('rxPatient').value = ''; 
    document.getElementById('rxDoctor').value = '';
    prescriptionModal.hide(); 
    await window.refreshAppLogs();
  });

  // Billing Submit Logic
  let billItems = [];
  document.getElementById('addBillItemBtn').addEventListener('click', () => {
    const name = document.getElementById('billItemName').value.trim();
    const qty = parseInt(document.getElementById('billItemQty').value) || 1;
    const cost = parseFloat(document.getElementById('billItemCost').value);
    
    if (name && cost >= 0 && qty > 0) {
      billItems.push({ name, qty, cost, total: (cost * qty) });
      document.getElementById('billItemName').value = ''; 
      document.getElementById('billItemCost').value = '';
      document.getElementById('billItemQty').value = '1';
      renderBillItems();
    }
  });

  const renderBillItems = () => {
    const tbody = document.getElementById('billItemsList');
    tbody.innerHTML = billItems.map((item, i) => `<tr>
      <td>${item.name}</td>
      <td class="text-center">${item.qty}</td>
      <td class="text-end">₹${item.cost.toFixed(2)}</td>
      <td class="text-end">₹${item.total.toFixed(2)}</td>
      <td class="text-end"><button class="btn btn-sm text-danger p-0 m-0" onclick="removeBillItem(${i})"><i class="bi bi-x-circle"></i></button></td>
    </tr>`).join('');
    document.getElementById('billTotalAmount').textContent = billItems.reduce((sum, item) => sum + item.total, 0).toFixed(2);
  };

  window.removeBillItem = (i) => { billItems.splice(i, 1); renderBillItems(); };

  document.getElementById('saveBillBtn').addEventListener('click', async () => {
    const patient = document.getElementById('billPatient').value.trim();
    const staff = document.getElementById('billStaff').value.trim();
    if (!patient || !staff || billItems.length === 0) return alert('Fill required fields and add items.');
    
    const total = billItems.reduce((sum, item) => sum + item.total, 0);
    const valueStr = `Total: ₹${total.toFixed(2)}`;
    const notesStr = billItems.map(i => `${i.qty}x ${i.name}: ₹${i.total.toFixed(2)}`).join(', ');

    const newBill = {
      patient, 
      logged_by: staff,
      metric: 'Bill', 
      context: 'Invoice', 
      value: valueStr, 
      notes: notesStr,
      status: 'Issued', 
      status_class: 'badge-soft-success', 
      reviewed: true
    };

    const { error } = await dbClient.from('health_logs').insert([newBill]);
    if (error) {
      alert('Failed to save bill: ' + error.message);
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.text("Medical Invoice", 14, 20); doc.setFontSize(10);
    doc.text(`Patient: ${patient}`, 14, 28); doc.text(`Date: ${new Date().toLocaleDateString()}`, 14, 34);
    
    const tableData = billItems.map(i => [i.name, i.qty.toString(), `INR ${i.cost.toFixed(2)}`, `INR ${i.total.toFixed(2)}`]);
    doc.autoTable({ startY: 42, head: [['Service / Item', 'Qty', 'Unit Price', 'Total Amount']], body: tableData, foot: [['', '', 'Total Due', `INR ${total.toFixed(2)}`]], theme: 'grid' });
    doc.save(`${patient.replace(/\s+/g, '_')}_Invoice.pdf`);

    billItems = []; 
    renderBillItems(); 
    document.getElementById('billPatient').value = '';
    billingModal.hide(); 
    await window.refreshAppLogs();
  });

  // Dynamic Section-Specific Export PDF Handler
  document.getElementById('exportPdfBtn').addEventListener('click', () => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const dateStr = new Date().toISOString().slice(0, 10);

    if (currentActiveView === 'view-rx') {
      const rxLogs = logs.filter(l => l.metric === 'Prescription');
      if (rxLogs.length === 0) return alert('No prescription records available to export.');

      doc.setFontSize(16);
      doc.text("Prescription Management Records", 14, 20);
      const tableData = rxLogs.map(l => [
        l.patient,
        l.value.replace(/<br\s*\/?>/gi, '\n'),
        l.loggedBy,
        new Date(l.date).toLocaleDateString()
      ]);
      doc.autoTable({ startY: 28, head: [['Patient', 'Medication Details', 'Prescribing Doctor', 'Date Issued']], body: tableData, theme: 'grid' });
      doc.save(`Prescriptions_${dateStr}.pdf`);

    } else if (currentActiveView === 'view-billing') {
      const billLogs = logs.filter(l => l.metric === 'Bill');
      if (billLogs.length === 0) return alert('No billing records available to export.');

      doc.setFontSize(16);
      doc.text("Medical Billing Records", 14, 20);
      const tableData = billLogs.map(l => [
        l.patient,
        l.value,
        l.notes || '-',
        l.loggedBy,
        new Date(l.date).toLocaleDateString()
      ]);
      doc.autoTable({ startY: 28, head: [['Patient', 'Total Bill', 'Breakdown Notes', 'Billed By', 'Date']], body: tableData, theme: 'grid' });
      doc.save(`Billing_Records_${dateStr}.pdf`);

    } else {
      const ehrLogs = logs.filter(l => l.metric !== 'Prescription' && l.metric !== 'Bill');
      if (ehrLogs.length === 0) return alert('No clinical records available to export.');

      doc.setFontSize(16);
      doc.text("Patient Health Records (EHR)", 14, 20);
      const tableData = ehrLogs.map(l => [
        l.patient,
        l.metric,
        `${l.value} ${metricUnits[l.metric] || ''}`,
        l.status || '-',
        `${new Date(l.date).toLocaleDateString()} (${l.loggedBy})`
      ]);
      doc.autoTable({ startY: 28, head: [['Patient', 'Metric', 'Value', 'Status', 'Date & Staff']], body: tableData, theme: 'grid' });
      doc.save(`Patient_Records_${dateStr}.pdf`);
    }
  });

  // Dynamic Section-Specific Export CSV Handler
  document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const dateStr = new Date().toISOString().slice(0, 10);
    let headers = [];
    let rows = [];
    let filename = '';

    if (currentActiveView === 'view-rx') {
      const rxLogs = logs.filter(l => l.metric === 'Prescription');
      if (rxLogs.length === 0) return alert('No prescription records available to export.');

      headers = ['Patient', 'Medication Details', 'Prescribing Doctor', 'Date Issued'];
      rows = rxLogs.map(l => [
        `"${l.patient.replace(/"/g, '""')}"`,
        `"${l.value.replace(/<br\s*\/?>/gi, '; ').replace(/"/g, '""')}"`,
        `"${l.loggedBy}"`,
        `"${new Date(l.date).toLocaleDateString()}"`
      ]);
      filename = `Prescriptions_${dateStr}.csv`;

    } else if (currentActiveView === 'view-billing') {
      const billLogs = logs.filter(l => l.metric === 'Bill');
      if (billLogs.length === 0) return alert('No billing records available to export.');

      headers = ['Patient', 'Bill Summary', 'Breakdown Notes', 'Billed By', 'Date'];
      rows = billLogs.map(l => [
        `"${l.patient.replace(/"/g, '""')}"`,
        `"${l.value.replace(/"/g, '""')}"`,
        `"${(l.notes || '').replace(/"/g, '""')}"`,
        `"${l.loggedBy}"`,
        `"${new Date(l.date).toLocaleDateString()}"`
      ]);
      filename = `Billing_Records_${dateStr}.csv`;

    } else {
      const ehrLogs = logs.filter(l => l.metric !== 'Prescription' && l.metric !== 'Bill');
      if (ehrLogs.length === 0) return alert('No clinical records available to export.');

      headers = ['Patient', 'Metric', 'Context', 'Value', 'Status', 'Logged By', 'Date'];
      rows = ehrLogs.map(l => [
        `"${l.patient.replace(/"/g, '""')}"`,
        `"${l.metric}"`,
        `"${l.context || ''}"`,
        `"${l.value}"`,
        `"${l.status || ''}"`,
        `"${l.loggedBy}"`,
        `"${new Date(l.date).toLocaleString()}"`
      ]);
      filename = `Patient_Records_${dateStr}.csv`;
    }

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  // Sample Data Generator
  document.getElementById('generateDataBtn').addEventListener('click', async () => {
    const sampleItems = [
      { patient: 'John Doe', metric: 'Heart Rate', value: '75', context: 'Resting', status: 'Normal', status_class: 'badge-soft-success', reviewed: true, logged_by: 'Dr. House' },
      { patient: 'Sarah Jenkins', metric: 'Prescription', value: '• Amoxicillin 500mg (1-0-1 for 5 days)', context: 'Rx', status: 'Active', status_class: 'badge-soft-purple', reviewed: true, logged_by: 'Dr. House' },
      { patient: 'Maria Garcia', metric: 'Bill', value: 'Total: ₹1500.00', notes: '1x Consultation: ₹500, 1x Blood Test: ₹1000', context: 'Invoice', status: 'Issued', status_class: 'badge-soft-success', reviewed: true, logged_by: 'Billing Dept' },
      { patient: 'Robert Chen', metric: 'Blood Pressure', value: '170/110', context: 'Routine', status: 'Critical', status_class: 'badge-soft-danger', reviewed: false, logged_by: 'RN Jones' },
      { patient: 'Emily Davis', metric: 'SpO2', value: '98', context: 'Resting', status: 'Normal', status_class: 'badge-soft-success', reviewed: true, logged_by: 'RN Smith' },
      { patient: 'David Wilson', metric: 'Blood Sugar', value: '210', context: 'Fasting', status: 'Critical', status_class: 'badge-soft-danger', reviewed: false, logged_by: 'Dr. Watson' },
      { patient: 'Anita Sharma', metric: 'Body Temp', value: '37.0', context: 'Routine', status: 'Normal', status_class: 'badge-soft-success', reviewed: true, logged_by: 'RN Jones' },
      { patient: 'Robert Chen', metric: 'Prescription', value: '• Amlodipine 5mg (1-0-0 for 14 days)', context: 'Rx', status: 'Active', status_class: 'badge-soft-purple', reviewed: true, logged_by: 'Dr. House' },
      { patient: 'Emily Davis', metric: 'Bill', value: 'Total: ₹2200.00', notes: '1x X-Ray Chest: ₹1200, 1x Consultation: ₹1000', context: 'Invoice', status: 'Issued', status_class: 'badge-soft-success', reviewed: true, logged_by: 'Billing Dept' }
    ];

    await dbClient.from('health_logs').insert(sampleItems);
    await window.refreshAppLogs();
  });

  document.getElementById('clearDataBtn').addEventListener('click', async () => {
    if (confirm('Clear entire database records for your user account?')) { 
      await dbClient.from('health_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await window.refreshAppLogs(); 
    }
  });

  // Search Event Listeners
  searchEHR.addEventListener('input', renderEHRTable);
  searchRx.addEventListener('input', renderRxTable);
  dateRx.addEventListener('input', renderRxTable);
  searchBill.addEventListener('input', renderBillTable);
  dateBill.addEventListener('input', renderBillTable);

  await window.refreshAppLogs();
});