const token = localStorage.getItem("id_token");
if (token) {
  showDashboard();
}

// Upgraded: Fetches and displays progress bar in real-time upon dashboard login
async function showDashboard() {
  authContainer.classList.add("hidden");
  dashboardContainer.classList.remove("hidden");
  const userEmail = localStorage.getItem("user_email");
  if (userEmail) {
    document.getElementById("client-welcome").innerText =
      `Welcome, ${userEmail}!`;
    await fetchClientStatus(userEmail);
  }
}

// Global var to store final returns unlocked by the backend
window.clientFinalReturns = [];

// Fetch client status from AWS DynamoDB
async function fetchClientStatus(email) {
  try {
    const response = await fetch(
      "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getClientStatus", userEmail: email }),
      },
    );
    const result = await response.json();

    if (response.ok && result.status === "SUCCESS") {
      updateProgressBar(result.campaignStatus);

      if (
        result.paymentConfirmed === true &&
        result.finalFiles &&
        result.finalFiles.length > 0
      ) {
        window.clientFinalReturns = result.finalFiles;
        renderFinalDeliverables();
      } else {
        document
          .getElementById("final-deliverables-box")
          .classList.add("hidden");
      }
    } else {
      document.getElementById("tracker-status-text").innerText =
        "Status offline.";
    }
  } catch (err) {
    document.getElementById("tracker-status-text").innerText =
      "Database connection offline.";
  }
}

// Render the Final Deliverables Download Box
function renderFinalDeliverables() {
  const box = document.getElementById("final-deliverables-box");
  const list = document.getElementById("final-files-list");
  list.innerHTML = "";

  window.clientFinalReturns.forEach((file) => {
    const safeKey = file.fileKey.replace(/'/g, "\\'");
    const safeName = file.fileName.replace(/'/g, "\\'");

    list.innerHTML += `
        <div class="flex items-center justify-between bg-white/50 border border-emerald-200/50 p-3 rounded-xl">
          <span class="text-sm font-bold text-emerald-900 truncate pr-4">📄 ${file.fileName}</span>
          <button onclick="downloadFinalReturn('${safeKey}', '${safeName}', this)" class="text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 shadow-md shadow-emerald-500/20 px-4 py-2 rounded-lg transition-all">
            Download Securely
          </button>
        </div>
      `;
  });
  box.classList.remove("hidden");
}

// Download Final Return Action
async function downloadFinalReturn(fileKey, fileName, buttonElement) {
  const userEmail = localStorage.getItem("user_email");
  if (!userEmail || !fileKey) return;

  const originalText = buttonElement.innerText;
  buttonElement.disabled = true;
  buttonElement.innerText = "Decrypting...";

  try {
    const response = await fetch(
      "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "getClientDownloadUrl",
          userEmail: userEmail,
          fileKey: fileKey,
        }),
      },
    );
    const result = await response.json();

    if (response.ok && result.status === "SUCCESS") {
      const fileResponse = await fetch(result.secureUrl);
      const blob = await fileResponse.blob();

      if ("showSaveFilePicker" in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: fileName,
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (e) {
          console.log("Cancelled");
        }
      } else {
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.setAttribute("download", fileName);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(downloadUrl);
      }
    } else {
      alert("Decryption failed. Please contact Wasim Kadri.");
    }
  } catch (err) {
    alert("Network error trying to unlock document vault.");
  } finally {
    buttonElement.disabled = false;
    buttonElement.innerText = originalText;
  }
}

// Dynamic visual layout stepper logic
function updateProgressBar(status) {
  const trackerText = document.getElementById("tracker-status-text");
  const stepOnboarding = document.getElementById("step-onboarding");
  const stepProcessing = document.getElementById("step-processing");
  const stepCompleted = document.getElementById("step-completed");

  [stepOnboarding, stepProcessing, stepCompleted].forEach((el) => {
    el.classList.remove("bg-amber-500", "bg-emerald-500", "animate-pulse");
    el.classList.add("bg-slate-200");
  });

  if (status === "Unsubmitted") {
    trackerText.innerText =
      "Action Required: Please complete and transmit your Onboarding Organizer.";
    stepOnboarding.classList.replace("bg-slate-200", "bg-amber-500");
    stepOnboarding.classList.add("animate-pulse");
  } else if (status === "Pending") {
    trackerText.innerText =
      "Onboarding Complete! Your tax file has been received and is queued for review.";
    stepOnboarding.classList.replace("bg-slate-200", "bg-emerald-500");
  } else if (status === "In Progress") {
    trackerText.innerText =
      "Advisors Processing: Wasim Kadri is actively preparing your tax return.";
    stepOnboarding.classList.replace("bg-slate-200", "bg-emerald-500");
    stepProcessing.classList.replace("bg-slate-200", "bg-amber-500");
    stepProcessing.classList.add("animate-pulse");
  } else if (status === "Completed") {
    trackerText.innerText =
      "Completed & Ready! Your tax return has been finalized.";
    stepOnboarding.classList.replace("bg-slate-200", "bg-emerald-500");
    stepProcessing.classList.replace("bg-slate-200", "bg-emerald-500");
    stepCompleted.classList.replace("bg-slate-200", "bg-emerald-500");
  }
}

function showLogin() {
  authContainer.classList.remove("hidden");
  dashboardContainer.classList.add("hidden");
  authTabs.classList.remove("hidden");
  switchToSignIn();
  localStorage.clear();
}

function switchToSignIn() {
  loginForm.classList.remove("hidden");
  registerForm.classList.add("hidden");
  verifyForm.classList.add("hidden");
  forgotForm.classList.add("hidden");
  resetConfirmForm.classList.add("hidden");
  tabSignIn.className =
    "flex-1 pb-3 text-sm font-bold border-b-2 border-brand-500 text-brand-600 focus:outline-none transition";
  tabSignUp.className =
    "flex-1 pb-3 text-sm font-bold border-b-2 border-transparent text-slate-400 hover:text-slate-600 focus:outline-none transition";
}

function switchToSignUp() {
  loginForm.classList.add("hidden");
  registerForm.classList.remove("hidden");
  verifyForm.classList.add("hidden");
  forgotForm.classList.add("hidden");
  resetConfirmForm.classList.add("hidden");
  tabSignUp.className =
    "flex-1 pb-3 text-sm font-bold border-b-2 border-brand-500 text-brand-600 focus:outline-none transition";
  tabSignIn.className =
    "flex-1 pb-3 text-sm font-bold border-b-2 border-transparent text-slate-400 hover:text-slate-600 focus:outline-none transition";
}

function switchToForgot() {
  authTabs.classList.add("hidden");
  loginForm.classList.add("hidden");
  registerForm.classList.add("hidden");
  verifyForm.classList.add("hidden");
  forgotForm.classList.remove("hidden");
  resetConfirmForm.classList.add("hidden");
}

if (tabSignIn) tabSignIn.addEventListener("click", switchToSignIn);
if (tabSignUp) tabSignUp.addEventListener("click", switchToSignUp);
if (linkForgot) linkForgot.addEventListener("click", switchToForgot);
if (btnCancelForgot) btnCancelForgot.addEventListener("click", showLogin);

// Progressive Password Checklist
const registerPasswordInput = document.getElementById("register-password");
if (registerPasswordInput) {
  let debounceTimer;
  registerPasswordInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const val = registerPasswordInput.value;
      updateChecklistRow("req-length", val.length >= 8);
      updateChecklistRow("req-upper", /[A-Z]/.test(val));
      updateChecklistRow("req-lower", /[a-z]/.test(val));
      updateChecklistRow("req-number", /\d/.test(val));
      updateChecklistRow(
        "req-special",
        /[\!\@\#\$\%\^\&\*\(\)\_\+\-\=\[\]\{\}\;\:\'\"\,\<\.\>\/\?~`]/.test(
          val,
        ),
      );
    }, 150);
  });
}
function updateChecklistRow(id, isPassed) {
  const row = document.getElementById(id);
  if (!row) return;
  const icon = row.querySelector(".req-icon");
  if (isPassed) {
    icon.innerText = "✓";
    row.className =
      "flex items-center gap-1.5 text-emerald-600 font-extrabold transition-all";
  } else {
    icon.innerText = "•";
    row.className =
      "flex items-center gap-1.5 text-slate-400 font-normal transition-all";
  }
}

// AWS Cognito Auth API Calls
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "Securing Connection...";
    }
    try {
      const response = await fetch(
        `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
          },
          body: JSON.stringify({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: COGNITO_CLIENT_ID,
            AuthParameters: { USERNAME: email, PASSWORD: password },
          }),
        },
      );
      let result = await response.json();
      if (response.ok && result.ChallengeName === "NEW_PASSWORD_REQUIRED") {
        const newPassword = prompt(
          "First-Time Sign-In: Choose a secure permanent password:",
        );
        if (!newPassword) {
          alert("Sign-in cancelled.");
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = "Sign In";
          }
          return;
        }
        const challengeResponse = await fetch(
          `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-amz-json-1.1",
              "X-Amz-Target":
                "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
            },
            body: JSON.stringify({
              ChallengeName: "NEW_PASSWORD_REQUIRED",
              ClientId: COGNITO_CLIENT_ID,
              Session: result.Session,
              ChallengeResponses: {
                USERNAME: email,
                NEW_PASSWORD: newPassword,
              },
            }),
          },
        );
        result = await challengeResponse.json();
      }
      if (result.AuthenticationResult) {
        localStorage.setItem("id_token", result.AuthenticationResult.IdToken);
        localStorage.setItem(
          "access_token",
          result.AuthenticationResult.AccessToken,
        );
        localStorage.setItem("user_email", email);
        showDashboard();
      } else {
        alert(
          "Authentication failed: " + (result.message || "Invalid credentials"),
        );
      }
    } catch (err) {
      alert("Network error trying to connect to cloud authentication.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = "Sign In to Portal";
      }
    }
  });
}

if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("register-name").value;
    const email = document.getElementById("register-email").value;
    const password = document.getElementById("register-password").value;
    const submitBtn = registerForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "Registering Profile...";
    }
    try {
      const response = await fetch(
        `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.SignUp",
          },
          body: JSON.stringify({
            ClientId: COGNITO_CLIENT_ID,
            Username: email,
            Password: password,
            UserAttributes: [{ Name: "name", Value: name }],
          }),
        },
      );
      const result = await response.json();
      if (response.ok) {
        pendingVerificationEmail = email;
        authTabs.classList.add("hidden");
        registerForm.classList.add("hidden");
        verifyForm.classList.remove("hidden");
      } else {
        alert(
          "Registration failed: " + (result.message || "Registration rejected"),
        );
      }
    } catch (err) {
      alert("Security network error during registration.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = "Create Portal Account";
      }
    }
  });
}

if (verifyForm) {
  verifyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("verify-code").value;
    const submitBtn = verifyForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "Verifying...";
    }
    try {
      const response = await fetch(
        `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.ConfirmSignUp",
          },
          body: JSON.stringify({
            ClientId: COGNITO_CLIENT_ID,
            Username: pendingVerificationEmail,
            ConfirmationCode: code,
          }),
        },
      );
      const result = await response.json();
      if (response.ok) {
        alert("Account verified successfully! You can now sign in.");
        showLogin();
      } else {
        alert(
          "Verification failed: " +
            (result.message || "Incorrect confirmation code"),
        );
      }
    } catch (err) {
      alert("Network error connecting to verification server.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = "Confirm Verification Code";
      }
    }
  });
}

if (forgotForm) {
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("forgot-email").value;
    const submitBtn = forgotForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "Triggering...";
    }
    try {
      const response = await fetch(
        `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.ForgotPassword",
          },
          body: JSON.stringify({
            ClientId: COGNITO_CLIENT_ID,
            Username: email,
          }),
        },
      );
      const result = await response.json();
      if (response.ok) {
        pendingResetEmail = email;
        forgotForm.classList.add("hidden");
        resetConfirmForm.classList.remove("hidden");
      } else {
        alert(
          "Reset request failed: " +
            (result.message || "Verification email could not be targeted."),
        );
      }
    } catch (err) {
      alert("Network error requesting password reset.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = "Request Reset Code";
      }
    }
  });
}

if (resetConfirmForm) {
  resetConfirmForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("reset-code").value;
    const newPassword = document.getElementById("reset-password-new").value;
    const submitBtn = resetConfirmForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "Saving Password...";
    }
    try {
      const response = await fetch(
        `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target":
              "AWSCognitoIdentityProviderService.ConfirmForgotPassword",
          },
          body: JSON.stringify({
            ChallengeName: "NEW_PASSWORD_REQUIRED",
            ClientId: COGNITO_CLIENT_ID,
            Username: pendingResetEmail,
            ConfirmationCode: code,
            Password: newPassword,
          }),
        },
      );
      const result = await response.json();
      if (response.ok) {
        alert(
          "Password successfully updated! You can now log in with your new credentials.",
        );
        showLogin();
      } else {
        alert(
          "Password update failed: " +
            (result.message || "Incorrect code or weak password."),
        );
      }
    } catch (err) {
      alert("Network error saving your new password.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = "Save New Password";
      }
    }
  });
}

if (btnChangePass) {
  const modal = document.getElementById("change-password-modal");
  const inputCurrent = document.getElementById("modal-current-password");
  const inputNew = document.getElementById("modal-new-password");
  const btnCancel = document.getElementById("btn-cancel-modal");
  const btnSubmit = document.getElementById("btn-submit-modal");

  btnChangePass.addEventListener("click", () => {
    inputCurrent.value = "";
    inputNew.value = "";
    modal.classList.remove("hidden");
  });

  const closeModal = () => modal.classList.add("hidden");
  btnCancel.addEventListener("click", closeModal);

  btnSubmit.addEventListener("click", async () => {
    const currentPassword = inputCurrent.value;
    const newPassword = inputNew.value;
    if (!currentPassword || !newPassword) {
      alert("Please enter both current and new passwords.");
      return;
    }

    const accessToken = localStorage.getItem("access_token");
    if (!accessToken) {
      alert("Session expired. Please log in again.");
      closeModal();
      showLogin();
      return;
    }

    const originalText = btnSubmit.innerText;
    btnSubmit.disabled = true;
    btnSubmit.innerText = "Updating...";

    try {
      const response = await fetch(
        `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.ChangePassword",
          },
          body: JSON.stringify({
            PreviousPassword: currentPassword,
            ProposedPassword: newPassword,
            AccessToken: accessToken,
          }),
        },
      );
      const result = await response.json();
      if (response.ok) {
        alert("Password updated successfully inside your secure AWS profile!");
        closeModal();
      } else {
        alert(
          "Failed to update password: " +
            (result.message || "Current password incorrect."),
        );
      }
    } catch (err) {
      alert("Network error connecting to password update server.");
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerText = originalText;
    }
  });
}

if (logoutBtn)
  logoutBtn.addEventListener("click", () => {
    showLogin();
  });

// ==============================================================
