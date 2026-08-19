// Production Client IDs pointing directly to Wasim's AWS account
const COGNITO_CLIENT_ID = "79d4qhnedttr14qh6gakkh5hk0";
const COGNITO_REGION = "ca-central-1";

const authContainer = document.getElementById("auth-container");
const dashboardContainer = document.getElementById("dashboard-container");
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const verifyForm = document.getElementById("verify-form");
const forgotForm = document.getElementById("forgot-form");
const resetConfirmForm = document.getElementById("reset-confirm-form");
const organizerForm = document.getElementById("organizer-form");
const authTabs = document.getElementById("auth-tabs");

const tabSignIn = document.getElementById("tab-signin");
const tabSignUp = document.getElementById("tab-signup");
const linkForgot = document.getElementById("link-forgot");
const btnCancelForgot = document.getElementById("btn-cancel-forgot");
const btnChangePass = document.getElementById("btn-change-pass");
const logoutBtn = document.getElementById("logout-btn");

let pendingVerificationEmail = "";
let pendingResetEmail = "";

// Memory queues
let vaultFileQueue = [];
let organizerFilesQueue = [];
let activeTaxType = "T1 Personal"; // Tracks which form the user is submitting
