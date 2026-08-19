// NEW: AUTHENTICATED DASHBOARD BOOKING ENGINE LOGIC
// ==============================================================
let dashMeetingType = "Microsoft Teams";
let dashBookingDate = "";
let dashBookingTime = "";

const dashBtnTeams = document.getElementById("dash-type-teams");
const dashBtnOffice = document.getElementById("dash-type-office");
const dashDatePicker = document.getElementById("dash-booking-date");
const dashSlotContainer = document.getElementById("dash-slot-container");
const dashTimeSlots = document.getElementById("dash-time-slots");
const dashConfirmation = document.getElementById("dash-booking-confirmation");
const dashSelectedDisplay = document.getElementById("dash-selected-display");
const dashConfirmBtn = document.getElementById("dash-confirm-btn");

if (dashDatePicker) {
  const today = new Date().toISOString().split("T")[0];
  dashDatePicker.setAttribute("min", today);
}

function updateDashMeetingType(type, activeBtn, inactiveBtn) {
  dashMeetingType = type;
  activeBtn.className =
    "border border-brand-500 bg-brand-500 text-white font-semibold py-2.5 px-4 rounded-xl text-xs transition-all shadow-sm";
  inactiveBtn.className =
    "border border-slate-300 bg-white text-slate-700 hover:border-brand-500 font-semibold py-2.5 px-4 rounded-xl text-xs transition-all shadow-sm";
  if (dashBookingTime)
    dashSelectedDisplay.innerText = `${dashMeetingType} on ${dashBookingDate} at ${dashBookingTime}`;
}

if (dashBtnTeams && dashBtnOffice) {
  dashBtnTeams.addEventListener("click", () =>
    updateDashMeetingType("Microsoft Teams", dashBtnTeams, dashBtnOffice),
  );
  dashBtnOffice.addEventListener("click", () =>
    updateDashMeetingType("In-Office", dashBtnOffice, dashBtnTeams),
  );
}

// LIVE MICROSOFT OUTLOOK SYNC FOR LOGGED-IN CLIENT DASHBOARD
if (dashDatePicker) {
  dashDatePicker.addEventListener("change", async (e) => {
    const selectedDateObj = new Date(e.target.value);
    const dayOfWeek = new Date(
      selectedDateObj.getTime() +
        Math.abs(selectedDateObj.getTimezoneOffset() * 60000),
    ).getDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      alert(
        "Our office is closed on weekends. Please select a date between Monday and Friday.",
      );
      dashDatePicker.value = "";
      dashSlotContainer.classList.add("hidden");
      dashConfirmation.classList.add("hidden");
      return;
    }

    dashBookingDate = e.target.value;
    dashConfirmation.classList.add("hidden");
    dashTimeSlots.innerHTML =
      "<p class='text-xs text-slate-400 col-span-2 sm:col-span-4 italic animate-pulse py-2'>Checking Wasim's Live Outlook Calendar...</p>";
    dashSlotContainer.classList.remove("hidden");

    try {
      const response = await fetch(
        "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "getAvailableSlots",
            bookingDate: dashBookingDate,
          }),
        },
      );

      const result = await response.json();
      dashTimeSlots.innerHTML = "";

      const liveSlots = result.slots || [];

      if (liveSlots.length === 0) {
        dashTimeSlots.innerHTML =
          "<p class='text-xs text-amber-600 col-span-2 sm:col-span-4 py-2 font-semibold'>No available slots found for this date.</p>";
        return;
      }

      liveSlots.forEach((slot) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.innerText = slot.time;

        if (!slot.isAvailable) {
          btn.className =
            "dash-slot-btn border border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed font-semibold py-2 px-3 rounded-xl text-xs line-through";
          btn.disabled = true;
        } else {
          btn.className =
            "dash-slot-btn border border-slate-300 text-slate-700 bg-white hover:border-brand-500 hover:text-brand-600 font-semibold py-2 px-3 rounded-xl text-xs transition-all shadow-sm";
          btn.onclick = () => {
            document
              .querySelectorAll(".dash-slot-btn:not(:disabled)")
              .forEach((b) => {
                b.classList.remove(
                  "bg-brand-500",
                  "text-white",
                  "border-brand-500",
                );
                b.classList.add(
                  "bg-white",
                  "text-slate-700",
                  "border-slate-300",
                );
              });
            btn.classList.remove(
              "bg-white",
              "text-slate-700",
              "border-slate-300",
            );
            btn.classList.add("bg-brand-500", "text-white", "border-brand-500");

            dashBookingTime = slot.time;
            dashSelectedDisplay.innerText = `${dashMeetingType} on ${dashBookingDate} at ${dashBookingTime}`;
            dashConfirmation.classList.remove("hidden");
          };
        }
        dashTimeSlots.appendChild(btn);
      });
    } catch (err) {
      console.error("Dashboard Calendar Error:", err);
      dashTimeSlots.innerHTML =
        "<p class='text-xs text-red-500 col-span-2 sm:col-span-4 py-2'>Error connecting to Microsoft Calendar servers.</p>";
    }
  });
}

if (dashConfirmBtn) {
  dashConfirmBtn.addEventListener("click", async () => {
    const userEmail = localStorage.getItem("user_email");
    if (!userEmail) {
      alert("Session expired. Please log in again.");
      showLogin();
      return;
    }

    const clientName = document.getElementById("org-firstname")?.value
      ? `${document.getElementById("org-firstname").value} ${document.getElementById("org-lastname").value}`
      : userEmail;
    const clientPhone =
      document.getElementById("org-telephone")?.value || "Not Provided";

    dashConfirmBtn.disabled = true;
    dashConfirmBtn.innerText = "Securing Appointment in AWS Cloud...";

    const bookingPayload = {
      action: "createBooking",
      meetingType: dashMeetingType,
      bookingDate: dashBookingDate,
      bookingTime: dashBookingTime,
      fullName: clientName,
      email: userEmail,
      phone: clientPhone,
      service: "Client Portal Consultation",
    };

    try {
      const response = await fetch(
        "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bookingPayload),
        },
      );
      const result = await response.json();

      if (response.ok && result.status === "SUCCESS") {
        alert(
          `🎉 Success! Your consultation (${dashMeetingType} on ${dashBookingDate} at ${dashBookingTime}) has been reserved. Wasim and team have been notified via email!`,
        );
        dashConfirmation.classList.add("hidden");
        dashSlotContainer.classList.add("hidden");
        dashDatePicker.value = "";
      } else {
        alert("Booking error: " + (result.message || "Failed to secure slot."));
      }
    } catch (err) {
      alert("Network error connecting to booking server.");
    } finally {
      dashConfirmBtn.disabled = false;
      dashConfirmBtn.innerText = "Confirm & Reserve Appointment";
    }
  });
}

// ==============================================================

// T1/T2 Toggle Buttons with Dynamic Required Validation
const tabT1 = document.getElementById("tab-t1");
const tabT2 = document.getElementById("tab-t2");
const t1Section = document.getElementById("t1-section");
const t2Section = document.getElementById("t2-section");

function setT1Required(isRequired) {
  const t1Fields = [
    "org-firstname",
    "org-lastname",
    "org-sin",
    "org-dob",
    "org-telephone",
    "org-address",
    "org-marital",
  ];
  t1Fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      if (isRequired) el.setAttribute("required", "true");
      else el.removeAttribute("required");
    }
  });
}

if (tabT1 && tabT2) {
  tabT1.addEventListener("click", () => {
    activeTaxType = "T1 Personal";
    t1Section.classList.remove("hidden");
    t2Section.classList.add("hidden");
    tabT1.className =
      "px-5 py-2 rounded-lg text-xs font-bold bg-white text-brand-700 shadow-sm transition-all";
    tabT2.className =
      "px-5 py-2 rounded-lg text-xs font-bold text-slate-500 hover:text-slate-800 transition-all";
    setT1Required(true); // Enable required validation for T1
  });
  tabT2.addEventListener("click", () => {
    activeTaxType = "T2 Corporate";
    t2Section.classList.remove("hidden");
    t1Section.classList.add("hidden");
    tabT2.className =
      "px-5 py-2 rounded-lg text-xs font-bold bg-white text-brand-700 shadow-sm transition-all";
    tabT1.className =
      "px-5 py-2 rounded-lg text-xs font-bold text-slate-500 hover:text-slate-800 transition-all";
    setT1Required(false); // Disable required validation for hidden T1 fields so T2 can submit!
  });
}

// Spousal Income Toggle
window.handleMaritalChange = function () {
  const ms = document.getElementById("org-marital").value;
  const spousalDiv = document.getElementById("spousal-income-container");
  if (ms === "married" || ms === "common-law") {
    spousalDiv.classList.remove("hidden");
  } else {
    spousalDiv.classList.add("hidden");
  }
};

// File Prompts
window.togglePrompt = function (id, value) {
  const el = document.getElementById("prompt-" + id);
  if (el) {
    if (value === "yes") {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
};

// T1 Accordions
const uberToggleYes = document.getElementById("uber-yes");
const uberToggleNo = document.getElementById("uber-no");
const uberSection = document.getElementById("uber-section");
const rentalToggleYes = document.getElementById("rental-yes");
const rentalToggleNo = document.getElementById("rental-no");
const rentalSection = document.getElementById("rental-section");
const ccbToggleYes = document.getElementById("ccb-yes");
const ccbToggleNo = document.getElementById("ccb-no");
const ccbSection = document.getElementById("ccb-section");

function updateConditionalSections() {
  if (uberToggleYes && uberToggleYes.checked)
    uberSection.classList.remove("hidden");
  else if (uberSection) uberSection.classList.add("hidden");
  if (rentalToggleYes && rentalToggleYes.checked)
    rentalSection.classList.remove("hidden");
  else if (rentalSection) rentalSection.classList.add("hidden");
  if (ccbToggleYes && ccbToggleYes.checked)
    ccbSection.classList.remove("hidden");
  else if (ccbSection) ccbSection.classList.add("hidden");
}
[
  uberToggleYes,
  uberToggleNo,
  rentalToggleYes,
  rentalToggleNo,
  ccbToggleYes,
  ccbToggleNo,
].forEach((radio) => {
  if (radio) radio.addEventListener("change", updateConditionalSections);
});

// Dynamic Tables
const familyTableBody = document.getElementById("family-table-body");
const residencyTableBody = document.getElementById("residency-table-body");
const ownerTableBody = document.getElementById("owner-table-body");
const directorTableBody = document.getElementById("director-table-body");

const btnAddFamily = document.getElementById("btn-add-family");
const btnAddResidency = document.getElementById("btn-add-residency");
const btnAddOwner = document.getElementById("btn-add-owner");
const btnAddDirector = document.getElementById("btn-add-director");

function addFamilyRow() {
  const emptyRow = document.getElementById("family-empty-row");
  if (emptyRow) emptyRow.remove();
  const row = document.createElement("tr");
  row.className =
    "family-row border-b border-slate-100 hover:bg-slate-50/50 transition-colors bg-white";
  row.innerHTML = `<td class="p-3"><input type="text" required placeholder="Dependent Name" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-slate-50/20 focus:ring-1 focus:ring-brand-500 outline-none" /></td><td class="p-3"><input type="text" maxlength="9" pattern="\\d{9}" required placeholder="000111222" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-slate-50/20 focus:ring-1 focus:ring-brand-500 outline-none font-mono" /></td><td class="p-3"><input type="date" required max="2026-12-31" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-brand-500 outline-none" /></td><td class="p-3"><select required class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-brand-500 outline-none"><option value="son">Son</option><option value="daughter">Daughter</option><option value="spouse">Spouse</option><option value="parent">Parent</option><option value="other">Other</option></select></td><td class="p-3"><select required class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-brand-500 outline-none"><option value="no">No</option><option value="yes">Yes</option></select></td><td class="p-3 text-center"><button type="button" class="btn-remove-row text-red-500 hover:text-red-700 hover:underline text-xs">Remove</button></td>`;
  row.querySelector(".btn-remove-row").addEventListener("click", () => {
    row.remove();
    checkFamilyEmpty();
  });
  familyTableBody.appendChild(row);
}
function checkFamilyEmpty() {
  if (familyTableBody.querySelectorAll(".family-row").length === 0) {
    familyTableBody.innerHTML = `<tr id="family-empty-row"><td colspan="6" class="p-4 text-center text-slate-400 italic">No dependents declared. Click "+ Add Dependent" to include one.</td></tr>`;
  }
}

function addResidencyRow() {
  const emptyRow = document.getElementById("residency-empty-row");
  if (emptyRow) emptyRow.remove();
  const row = document.createElement("tr");
  row.className =
    "residency-row border-b border-slate-100 hover:bg-slate-50/50 transition-colors bg-white";
  row.innerHTML = `<td class="p-3"><input type="number" min="1" max="12" required placeholder="Months" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-brand-500 outline-none font-bold" /></td><td class="p-3"><input type="text" required placeholder="Property Address" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-brand-500 outline-none" /></td><td class="p-3"><input type="text" required placeholder="Municipality / Landlord" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-brand-500 outline-none" /></td><td class="p-3 text-center"><button type="button" class="btn-remove-row text-red-500 hover:text-red-700 hover:underline text-xs">Remove</button></td>`;
  row.querySelector(".btn-remove-row").addEventListener("click", () => {
    row.remove();
    checkResidencyEmpty();
  });
  residencyTableBody.appendChild(row);
}
function checkResidencyEmpty() {
  if (residencyTableBody.querySelectorAll(".residency-row").length === 0) {
    residencyTableBody.innerHTML = `<tr id="residency-empty-row"><td colspan="4" class="p-4 text-center text-slate-400 italic">No residency rows declared. Click "+ Add Address Row" to add a ledger row.</td></tr>`;
  }
}

function addOwnerRow() {
  const emptyRow = document.getElementById("owner-empty-row");
  if (emptyRow) emptyRow.remove();
  const row = document.createElement("tr");
  row.className =
    "owner-row border-b border-slate-100 hover:bg-slate-50/50 transition-colors bg-white";
  row.innerHTML = `<td class="p-2.5"><input type="text" required placeholder="Investor Name" class="w-full px-2.5 py-1 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-indigo-500 outline-none" /></td><td class="p-2.5"><input type="text" required maxlength="9" pattern="\\d{9}" placeholder="000111222" class="w-full px-2.5 py-1 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-indigo-500 outline-none font-mono" /></td><td class="p-2.5"><input type="number" min="1" max="100" required placeholder="%" class="w-full px-2.5 py-1 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-indigo-500 outline-none font-bold" /></td><td class="p-2.5"><input type="text" required placeholder="Investor Mailing Address" class="w-full px-2.5 py-1 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-indigo-500 outline-none" /></td><td class="p-2.5 text-center"><button type="button" class="btn-remove-row text-red-500 hover:text-red-700 hover:underline text-xs">Remove</button></td>`;
  row.querySelector(".btn-remove-row").addEventListener("click", () => {
    row.remove();
    checkOwnerEmpty();
  });
  ownerTableBody.appendChild(row);
}
function checkOwnerEmpty() {
  if (
    ownerTableBody &&
    ownerTableBody.querySelectorAll(".owner-row").length === 0
  ) {
    ownerTableBody.innerHTML = `<tr id="owner-empty-row"><td colspan="5" class="p-4 text-center text-slate-400 italic">No co-investors declared. Defaults to 100% sole owner.</td></tr>`;
  }
}

function addDirectorRow() {
  const emptyRow = document.getElementById("director-empty-row");
  if (emptyRow) emptyRow.remove();
  const row = document.createElement("tr");
  row.className =
    "director-row border-b border-slate-100 hover:bg-slate-50/50 transition-colors bg-white";
  row.innerHTML = `<td class="p-3"><input type="text" required placeholder="Director Name" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-slate-800 outline-none" /></td><td class="p-3"><input type="text" maxlength="9" pattern="\\d{9}" required placeholder="000111222" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-slate-800 outline-none font-mono" /></td><td class="p-3"><input type="number" min="0" max="100" required placeholder="%" class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-slate-800 outline-none" /></td><td class="p-3"><input type="text" required placeholder="President, Sec..." class="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:ring-1 focus:ring-slate-800 outline-none" /></td><td class="p-3 text-center"><button type="button" class="btn-remove-row text-red-500 hover:text-red-700 hover:underline text-xs">Remove</button></td>`;
  row.querySelector(".btn-remove-row").addEventListener("click", () => {
    row.remove();
    checkDirectorEmpty();
  });
  directorTableBody.appendChild(row);
}
function checkDirectorEmpty() {
  if (
    directorTableBody &&
    directorTableBody.querySelectorAll(".director-row").length === 0
  ) {
    directorTableBody.innerHTML = `<tr id="director-empty-row"><td colspan="5" class="p-4 text-center text-slate-400 italic">No directors declared. Click "+ Add Director".</td></tr>`;
  }
}

if (btnAddFamily) btnAddFamily.addEventListener("click", addFamilyRow);
if (btnAddResidency) btnAddResidency.addEventListener("click", addResidencyRow);
if (btnAddOwner) btnAddOwner.addEventListener("click", addOwnerRow);
if (btnAddDirector) btnAddDirector.addEventListener("click", addDirectorRow);

// Dynamic Inline File Queue
window.removeOrganizerFile = function (id, containerId) {
  organizerFilesQueue = organizerFilesQueue.filter((f) => f.id !== id);
  renderOrganizerFiles(containerId);
};
function renderOrganizerFiles(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  const relevantFiles = organizerFilesQueue.filter(
    (f) => f.containerId === containerId,
  );
  relevantFiles.forEach((item) => {
    container.innerHTML += `<div class="flex justify-between items-center bg-white border border-brand-200 rounded p-1.5 text-[9px] font-bold text-slate-600 shadow-sm mt-1"><span class="truncate w-3/4 px-1">${item.file.name}</span><button type="button" onclick="removeOrganizerFile('${item.id}', '${containerId}')" class="text-red-500 hover:underline cursor-pointer">Remove</button></div>`;
  });
}
window.handleOrganizerUpload = function (input, prefix, containerId) {
  if (input.files.length === 0) return;
  for (let i = 0; i < input.files.length; i++) {
    const origFile = input.files[i];
    const renamedFile = new File([origFile], `${prefix} ${origFile.name}`, {
      type: origFile.type,
      lastModified: origFile.lastModified,
    });
    organizerFilesQueue.push({
      id: Math.random().toString(36).substr(2, 9),
      file: renamedFile,
      containerId: containerId,
      fileKey: "",
    });
  }
  renderOrganizerFiles(containerId);
  input.value = "";
};

// Secure Submission Logic
if (organizerForm) {
  organizerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const userEmail = localStorage.getItem("user_email");
    if (!userEmail) {
      alert("Session expired. Please log in again.");
      showLogin();
      return;
    }

    const consentBox = document.getElementById("org-cra-consent");
    if (!consentBox.checked) {
      alert("You must authorize CRA representation to proceed.");
      return;
    }

    const submitBtn = organizerForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "Transmitting Data...";
    }

    try {
      // FILTER FILES STRICTLY BY FORM SELECTION (T1 VS T2 ISOLATION)
      const relevantFilesToUpload = organizerFilesQueue.filter((item) => {
        if (activeTaxType.includes("T2")) {
          return item.containerId === "list-t2-docs";
        } else {
          return item.containerId !== "list-t2-docs";
        }
      });

      if (relevantFilesToUpload.length > 0) {
        for (let i = 0; i < relevantFilesToUpload.length; i++) {
          const fileObj = relevantFilesToUpload[i].file;
          if (submitBtn)
            submitBtn.innerText = `Uploading Doc ${i + 1} of ${relevantFilesToUpload.length}...`;
          const authRes = await fetch(
            "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "getUploadUrl",
                fileName: fileObj.name,
                fileType: fileObj.type,
                userEmail: userEmail,
              }),
            },
          );
          const authResult = await authRes.json();
          if (!authRes.ok || authResult.status !== "SUCCESS")
            throw new Error(authResult.message);
          const uploadRes = await fetch(authResult.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": fileObj.type },
            body: fileObj,
          });
          if (!uploadRes.ok) {
            const errTxt = await uploadRes.text();
            let errMsg = "S3 rejected the file.";
            try {
              const doc = new DOMParser().parseFromString(errTxt, "text/xml");
              const msg = doc.getElementsByTagName("Message")[0];
              if (msg) errMsg = "S3 Error: " + msg.textContent;
            } catch (e) {}
            throw new Error(errMsg);
          }
          relevantFilesToUpload[i].fileKey = authResult.fileKey;
        }
      }

      if (submitBtn) submitBtn.innerText = "Finalizing Digital Report...";
      const timestamp = new Date().toISOString();

      // Dynamic Table Extraction
      const dependentsArray = Array.from(
        organizerForm.querySelectorAll(".family-row"),
      ).map((row) => {
        const i = row.querySelectorAll("input, select");
        return {
          name: i[0].value,
          sin: i[1].value,
          dob: i[2].value,
          relationship: i[3].value,
          disability: i[4].value,
        };
      });
      const residencyArray = Array.from(
        organizerForm.querySelectorAll(".residency-row"),
      ).map((row) => {
        const i = row.querySelectorAll("input");
        return {
          months: i[0].value,
          address: i[1].value,
          landlord: i[2].value,
        };
      });
      const ownersArray = Array.from(
        organizerForm.querySelectorAll(".owner-row"),
      ).map((row) => {
        const i = row.querySelectorAll("input");
        return {
          name: i[0].value,
          sin: i[1].value,
          share: i[2].value,
          address: i[3].value,
        };
      });
      const directorsArray = Array.from(
        organizerForm.querySelectorAll(".director-row"),
      ).map((row) => {
        const i = row.querySelectorAll("input");
        return {
          name: i[0].value,
          sin: i[1].value,
          share: i[2].value,
          role: i[3].value,
        };
      });

      const payload = {
        action: "submitTaxOrganizer",
        userEmail: userEmail,
        taxType: activeTaxType,
        craConsent: `Yes, Authorized via secure digital timestamp: ${timestamp}`,
        uploadedFiles: relevantFilesToUpload.map((item) => ({
          fileName: item.file.name,
          fileKey: item.fileKey,
        })),
        notes: document.getElementById("org-notes").value || "None provided.",

        personalInfo: {
          firstName: document.getElementById("org-firstname").value,
          middleName: document.getElementById("org-middlename").value,
          lastName: document.getElementById("org-lastname").value,
          sin: document.getElementById("org-sin").value,
          telephone: document.getElementById("org-telephone").value,
          address: document.getElementById("org-address").value,
          usCitizen: document.getElementById("org-us-citizen").value,
          maritalStatus: document.getElementById("org-marital").value,
          dob: document.getElementById("org-dob").value,
          spousalIncome:
            document.getElementById("org-spousal-income").value || "0.00",
          howHeard: document.getElementById("org-howheard").value,
        },
        familyMembers: dependentsArray,
        statusInCanada: {
          status: document.getElementById("org-immigration-status").value,
          entryDate: document.getElementById("org-immigration-entry").value,
        },
        ontarioResidency: residencyArray,
        milestones: {
          electionsCanada:
            organizerForm.querySelector('input[name="org-elections"]:checked')
              ?.value || "no",
          directDeposit:
            organizerForm.querySelector(
              'input[name="org-directdeposit"]:checked',
            )?.value || "no",
          tuition:
            organizerForm.querySelector('input[name="org-tuition"]:checked')
              ?.value || "no",
          rrsp:
            organizerForm.querySelector('input[name="org-rrsp"]:checked')
              ?.value || "no",
          charitable:
            organizerForm.querySelector('input[name="org-charitable"]:checked')
              ?.value || "no",
          crypto:
            organizerForm.querySelector('input[name="org-crypto"]:checked')
              ?.value || "no",
          daycare:
            organizerForm.querySelector('input[name="org-daycare"]:checked')
              ?.value || "no",
          workFromHome:
            organizerForm.querySelector('input[name="org-wfh"]:checked')
              ?.value || "no",
          purchasedHome:
            organizerForm.querySelector('input[name="org-purchased"]:checked')
              ?.value || "no",
        },
        selfEmployed: {
          active:
            organizerForm.querySelector('input[name="org-uber-toggle"]:checked')
              ?.value || "no",
          hstNo: document.getElementById("uber-hst").value,
          accessCode: document.getElementById("uber-access").value,
          periodFrom: document.getElementById("uber-from").value,
          periodTo: document.getElementById("uber-to").value,
          totalKms: document.getElementById("uber-total-kms").value,
          businessKms: document.getElementById("uber-business-kms").value,
          expenses: {
            fuel: document.getElementById("exp-fuel").value,
            repairs: document.getElementById("exp-repairs").value,
            insurance: document.getElementById("exp-insurance").value,
            license: document.getElementById("exp-licence").value,
            interest: document.getElementById("exp-interest").value,
            carwash: document.getElementById("exp-carwash").value,
            parking: document.getElementById("exp-parking").value,
            tolls: document.getElementById("exp-tolls").value,
            tickets: document.getElementById("exp-tickets").value,
            phone: document.getElementById("exp-phone").value,
            supplies: document.getElementById("exp-supplies").value,
            meals: document.getElementById("exp-meals").value,
          },
        },
        rentalIncome: {
          active:
            organizerForm.querySelector(
              'input[name="org-rental-toggle"]:checked',
            )?.value || "no",
          address: document.getElementById("rent-address").value,
          grossIncome: document.getElementById("rent-gross").value,
          percentageRented: document.getElementById("rent-percentage").value,
          coOwners: ownersArray,
          expenses: {
            insurance: document.getElementById("rent-exp-ins").value,
            interest: document.getElementById("rent-exp-interest").value,
            bankCharges: document.getElementById("rent-exp-bank").value,
            office: document.getElementById("rent-exp-office").value,
            professional: document.getElementById("rent-exp-prof").value,
            management: document.getElementById("rent-exp-manage").value,
            repairs: document.getElementById("rent-exp-repairs").value,
            propertyTax: document.getElementById("rent-exp-tax").value,
            utilities: document.getElementById("rent-exp-utilities").value,
          },
        },
        childCareBenefit: {
          active:
            organizerForm.querySelector('input[name="org-ccb-toggle"]:checked')
              ?.value || "no",
          marriageDate: document.getElementById("ccb-marriage-date").value,
          statusChangeDate: document.getElementById("ccb-status-date").value,
          worldIncome: {
            becameResidentYear:
              document.getElementById("ccb-world-entry").value,
            oneYearBefore: document.getElementById("ccb-world-prev1").value,
            twoYearsBefore: document.getElementById("ccb-world-prev2").value,
          },
        },
        corporateInfo: {
          corpName: document.getElementById("t2-corp-name").value,
          businessNumber: document.getElementById("t2-bn").value,
          incDate: document.getElementById("t2-inc-date").value,
          fiscalYearEnd: document.getElementById("t2-yearend").value,
          software: document.getElementById("t2-software").value,
          industry: document.getElementById("t2-industry").value,
          remittance: {
            gst:
              organizerForm.querySelector('input[name="t2-gst"]:checked')
                ?.value || "no",
            payroll:
              organizerForm.querySelector('input[name="t2-payroll"]:checked')
                ?.value || "no",
          },
          directors: directorsArray,
        },
      };

      const jsonResponse = await fetch(
        "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const jsonResult = await jsonResponse.json();

      if (jsonResponse.ok && jsonResult.status === "SUCCESS") {
        alert(
          "Organizer Profile and all attached documents transmitted securely!",
        );
        organizerForm.reset();
        organizerFilesQueue = [];
        document
          .querySelectorAll('[id^="list-"]')
          .forEach((list) => (list.innerHTML = ""));
        document
          .querySelectorAll('[id^="prompt-"]')
          .forEach((p) => p.classList.add("hidden"));
        document
          .getElementById("spousal-income-container")
          .classList.add("hidden");
        familyTableBody.innerHTML = `<tr id="family-empty-row"><td colspan="6" class="p-4 text-center text-slate-400 italic">No dependents declared. Click "+ Add Dependent" to include one.</td></tr>`;
        residencyTableBody.innerHTML = `<tr id="residency-empty-row"><td colspan="4" class="p-4 text-center text-slate-400 italic">No residency rows declared. Click "+ Add Address Row" to add a ledger row.</td></tr>`;
        ownerTableBody.innerHTML = `<tr id="owner-empty-row"><td colspan="5" class="p-4 text-center text-slate-400 italic">No co-investors declared. Defaults to 100% sole owner.</td></tr>`;
        directorTableBody.innerHTML = `<tr id="director-empty-row"><td colspan="5" class="p-4 text-center text-slate-400 italic">No directors declared. Click "+ Add Director".</td></tr>`;
        updateConditionalSections();
      } else {
        alert(
          "Submission failed: " +
            (jsonResult.message || "Unknown server error"),
        );
      }
    } catch (err) {
      alert("Network error. Unable to complete cloud transmission.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = "Transmit Onboarding Organizer";
      }
    }
  });
}
