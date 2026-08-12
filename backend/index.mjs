import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient, AdminListGroupsForUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const s3 = new S3Client({ region: "ca-central-1" });
const ses = new SESClient({ region: "ca-central-1" });
const sns = new SNSClient({ region: "ca-central-1" });
const ddbClient = new DynamoDBClient({ region: "ca-central-1" });
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const cognito = new CognitoIdentityProviderClient({ region: "ca-central-1" });
const bedrock = new BedrockRuntimeClient({ region: "ca-central-1" });

const BUCKET_NAME = "fiscalx-document-vault-673098723249";
const TABLE_NAME = "fiscalx-client-onboarding";
const USER_POOL_ID = "ca-central-1_omKzLVfdI"; 
const SENDER_EMAIL = "info@fiscalx.ca"; 
const OFFICE_EMAIL = "info@fiscalx.ca"; 
const MS_CLIENT_ID = "359dc7f8-359d-47ab-abcf-c0129559aacb";
const MS_TENANT_ID = "8793dd74-ad92-4663-a197-95c9e0955c5e";
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET; 
const MS_REDIRECT_URI = "https://www.fiscalx.ca/admin/";

const QBO_CLIENT_ID = "ABpC4zd9xPXxZkN9AgXd8mGM2EvvT1Uiw1bt9BvUJHBRxvoXex"; 
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET; 
const QBO_REDIRECT_URI = "https://fiscalx.ca/admin/"; 
const QBO_ENVIRONMENT = "production";

const AUTHORIZED_STAFF = [
    "wasim@fiscalx.ca",
    "saad@fiscalx.ca",
    "admin@fiscalx.ca",
    "cooldude014317@gmail.com",
    "arfa786.sa@gmail.com"
];

async function isStaff(email) {
    if (!email) return false;
    try {
        const command = new AdminListGroupsForUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: email.trim()
        });
        const result = await cognito.send(command);
        const groups = (result.Groups || []).map(g => g.GroupName);
        return groups.includes("Staff");
    } catch (err) {
        console.error(`Cognito group check failed for ${email}:`, err);
        return false;
    }
}

async function getMsAccessToken() {
    try {
        const configRes = await ddbDocClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "userEmail = :e AND #ts = :t",
            ExpressionAttributeNames: { "#ts": "timestamp" },
            ExpressionAttributeValues: { ":e": "SYSTEM_CONFIG", ":t": "MICROSOFT_OUTLOOK_AUTH" }
        }));
        const configItem = (configRes.Items || [])[0];
        if (!configItem || !configItem.msRefreshToken) return null;

        const tokenRes = await fetch(`https://login.microsoftonline.com/common/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: MS_CLIENT_ID,
                client_secret: MS_CLIENT_SECRET,
                refresh_token: configItem.msRefreshToken,
                grant_type: 'refresh_token'
            })
        });
        const tokenData = await tokenRes.json();
        return tokenData.access_token || null;
    } catch (err) {
        console.error("Microsoft Token Refresh Error:", err);
        return null;
    }
}

async function getQboAccessToken() {
    try {
        const configRes = await ddbDocClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "userEmail = :e AND #ts = :t",
            ExpressionAttributeNames: { "#ts": "timestamp" },
            ExpressionAttributeValues: { ":e": "SYSTEM_CONFIG", ":t": "QUICKBOOKS_AUTH" }
        }));
        const configItem = (configRes.Items || [])[0];
        if (!configItem || !configItem.qboRefreshToken) return null;

        const authHeader = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64');

        const tokenRes = await fetch(`https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, {
            method: 'POST',
            headers: { 
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${authHeader}`
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: configItem.qboRefreshToken
            })
        });
        
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) throw new Error("QBO Token Refresh Failed");

        await ddbDocClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { "userEmail": "SYSTEM_CONFIG", "timestamp": "QUICKBOOKS_AUTH" },
            UpdateExpression: "set qboRefreshToken = :r, updatedAt = :u",
            ExpressionAttributeValues: { ":r": tokenData.refresh_token, ":u": new Date().toISOString() }
        }));

        return { accessToken: tokenData.access_token, realmId: configItem.qboRealmId || "UNKNOWN" };
    } catch (err) {
        console.error("QuickBooks Token Refresh Error:", err);
        return null;
    }
}

export const handler = async (event) => {
    console.log("Incoming Event Payload:", JSON.stringify(event));
    console.log("DIAGNOSTIC - QBO ID:", QBO_CLIENT_ID, "QBO SECRET Length:", QBO_CLIENT_SECRET ? QBO_CLIENT_SECRET.length : "MISSING/UNDEFINED");

    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    };

    if (event.requestContext && event.requestContext.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: headers, body: JSON.stringify({ message: "CORS preflight successful" }) };
    }

    try {
        const data = event.body ? JSON.parse(event.body) : event;

        if (data.action === "getUploadUrl") {
            const fileName = data.fileName;
            const fileType = data.fileType;
            const userEmail = data.userEmail;

            const fileKey = `clients/${userEmail}/${Date.now()}-${fileName}`;
            const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey, ContentType: fileType });
            const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", uploadUrl: uploadUrl, fileKey: fileKey }) };
        }

        if (data.action === "notifyUploadComplete") {
            const fileKey = data.fileKey;
            const userEmail = data.userEmail;
            const fileName = fileKey.split("/").pop(); 
            const cleanFileName = fileName.substring(13); 

            try {
                const scanParams = {
                    TableName: TABLE_NAME,
                    FilterExpression: "userEmail = :email",
                    ExpressionAttributeValues: { ":email": userEmail }
                };
                const scanResult = await ddbDocClient.send(new ScanCommand(scanParams));
                const userRecords = scanResult.Items || [];

                if (userRecords.length > 0) {
                    userRecords.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                    const latestRecord = userRecords[0];
                    const existingFiles = latestRecord.uploadedFiles || [];
                    
                    if (!existingFiles.some(f => f.fileKey === fileKey)) {
                        existingFiles.push({ fileName: cleanFileName, fileKey: fileKey });
                        await ddbDocClient.send(new UpdateCommand({
                            TableName: TABLE_NAME,
                            Key: { userEmail: latestRecord.userEmail, timestamp: latestRecord.timestamp },
                            UpdateExpression: "set uploadedFiles = :f",
                            ExpressionAttributeValues: { ":f": existingFiles }
                        }));
                    }
                }
            } catch (dbError) {
                console.error("Failed to automatically link S3 upload to DynamoDB record:", dbError);
            }

            const downloadCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey });
            const downloadUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 86400 });

            const emailHtml = `
                <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                    <h2 style="color: #4f46e5; margin-bottom: 4px;">FiscalX Document Vault</h2>
                    <p style="font-size: 14px; color: #64748b; margin-top: 0;">Automated Client Upload Notification</p>
                    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                    <p style="font-size: 15px;">Hello Administrative Team,</p>
                    <p style="font-size: 15px;">A client has successfully uploaded a new document to their secure private folder:</p>
                    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <tr><td style="padding: 12px; font-weight: bold; color: #475569; width: 140px; border-bottom: 1px solid #e2e8f0;">Client Email:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${userEmail}</td></tr>
                        <tr><td style="padding: 12px; font-weight: bold; color: #475569; border-bottom: 1px solid #e2e8f0;">File Name:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${cleanFileName}</td></tr>
                    </table>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${downloadUrl}" target="_blank" style="background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 14px 28px; font-weight: bold; font-size: 14px; border-radius: 8px;">Download Document Securely</a>
                    </div>
                </div>
            `;

            await ses.send(new SendEmailCommand({
                Source: SENDER_EMAIL, Destination: { ToAddresses: [OFFICE_EMAIL] },
                Message: { Subject: { Charset: "UTF-8", Data: `[Vault Alert] New Client Upload from ${userEmail}` }, Body: { Html: { Charset: "UTF-8", Data: emailHtml } } }
            }));

            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
        }

        if (data.action === "submitTaxOrganizer") {
            const {
                userEmail = "Unknown", taxType = "T1 Personal", craConsent = "Not Provided", howHeard = "Not Specified",
                personalInfo = {}, familyMembers = [], statusInCanada = {}, ontarioResidency = [], milestones = {},
                selfEmployed = {}, rentalIncome = {}, childCareBenefit = {}, corporateInfo = {}, notes = "None provided.", uploadedFiles = [] 
            } = data;

            const isT2 = taxType.includes("T2");
            const combinedName = isT2 ? corporateInfo.corpName : `${personalInfo.firstName || ""} ${personalInfo.middleName || ""} ${personalInfo.lastName || ""}`.trim();
            const timestamp = new Date().toISOString();

            await ddbDocClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    userEmail: userEmail, timestamp: timestamp, taxType: taxType, craConsent: craConsent, clientName: combinedName,
                    amountOwed: "0.00", amountCollected: "0.00", campaignStatus: "Pending", howHeard: howHeard, notes: notes,
                    uploadedFiles: uploadedFiles, personalInfo: personalInfo, corporateInfo: corporateInfo, statusInCanada: statusInCanada,
                    familyMembers: familyMembers, ontarioResidency: ontarioResidency, milestones: milestones, selfEmployed: selfEmployed,
                    rentalIncome: rentalIncome, childCareBenefit: childCareBenefit,
                    paymentConfirmed: false, finalFiles: []
                }
            }));

            const csvRows = [ ["Section", "Field", "Value"] ];
            csvRows.push(["System", "Tax Type", taxType], ["System", "CRA Consent", craConsent], ["System", "Client Email", userEmail], ["System", "Client Notes", notes], ["System", "How Heard", howHeard]);

            if (isT2) {
                csvRows.push(
                    ["T2 Corporate", "Corporate Name", corporateInfo.corpName || "N/A"], ["T2 Corporate", "Business Number", corporateInfo.businessNumber || "N/A"],
                    ["T2 Corporate", "Date of Incorporation", corporateInfo.incDate || "N/A"], ["T2 Corporate", "Fiscal Year End", corporateInfo.fiscalYearEnd || "N/A"],
                    ["T2 Corporate", "Bookkeeping Software", corporateInfo.software || "N/A"], ["T2 Corporate", "Primary Industry", corporateInfo.industry || "N/A"],
                    ["T2 Remittance", "GST/HST Registered", corporateInfo.remittance?.gst || "no"], ["T2 Remittance", "Payroll Registered", corporateInfo.remittance?.payroll || "no"]
                );
                if (corporateInfo.directors && corporateInfo.directors.length > 0) {
                    corporateInfo.directors.forEach((d, index) => { csvRows.push(["Director " + (index + 1), "Name", d.name], ["Director " + (index + 1), "SIN", d.sin], ["Director " + (index + 1), "Share %", d.share], ["Director " + (index + 1), "Role", d.role]); });
                }
            } else {
                csvRows.push(
                    ["T1 Personal", "Full Name", combinedName || "N/A"], ["T1 Personal", "SIN", personalInfo.sin || "N/A"], ["T1 Personal", "Telephone", personalInfo.telephone || "N/A"], ["T1 Personal", "Address", personalInfo.address || "N/A"], ["T1 Personal", "US Citizen", personalInfo.usCitizen || "N/A"], ["T1 Personal", "Marital Status", personalInfo.maritalStatus || "N/A"], ["T1 Personal", "Spousal Income ($)", personalInfo.spousalIncome || "0.00"],
                    ["T1 Status", "Immigration Status", statusInCanada.status || "N/A"], ["T1 Status", "Entry Date", statusInCanada.entryDate || "N/A"]
                );
            }
            
            const csvString = csvRows.map(row => row.map(cell => `"${(cell||'').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
            const csvKey = `clients/${userEmail}/${Date.now()}-${taxType.substring(0,2)}-Organizer.csv`;
            await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: csvKey, Body: csvString, ContentType: "text/csv" }));
            const excelDownloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: csvKey }), { expiresIn: 86400 });

            const organizerHtml = `
                <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 650px; margin: 0 auto; border: 1px solid #e2e8f0;">
                    <h2 style="color: #059669; margin-bottom: 4px;">FiscalX Professional Portal</h2>
                    <p style="font-size: 14px; color: #64748b; margin-top: 0;">Completed Tax Organizer (${taxType})</p>
                    <div style="margin-top: 15px; padding: 12px; background-color: #fef3c7; border: 1px solid #fde68a; border-radius: 8px;">
                        <p style="font-size: 12px; color: #92400e; margin: 0;"><strong>Client Email:</strong> ${userEmail}</p>
                    </div>
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${excelDownloadUrl}" target="_blank" style="background-color: #059669; color: #ffffff; text-decoration: none; padding: 14px 28px; font-weight: bold; font-size: 14px; border-radius: 8px;">📊 Download Full Data as Excel (.CSV)</a>
                    </div>
                </div>
            `;

            await ses.send(new SendEmailCommand({
                Source: SENDER_EMAIL, Destination: { ToAddresses: [OFFICE_EMAIL] },
                Message: { Subject: { Charset: "UTF-8", Data: `[${taxType}] Complete Onboarding from ${combinedName || userEmail}` }, Body: { Html: { Charset: "UTF-8", Data: organizerHtml } } }
            }));

            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Your onboarding organizer and files have been securely compiled and delivered." }) };
        }

        if (data.action === "getCrmData") {
            const adminEmail = data.adminEmail;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized." }) };

            const scanResult = await ddbDocClient.send(new ScanCommand({ TableName: TABLE_NAME }));
            const clients = (scanResult.Items || []).filter(c => c.userEmail !== "SYSTEM_CONFIG" && !c.userEmail.includes("QBO_INVOICE#"));

            const total = clients.length;
            const inProgress = clients.filter(c => c.campaignStatus === 'Pending' || c.campaignStatus === 'In Progress').length;
            const completed = clients.filter(c => c.campaignStatus === 'Completed').length;

            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", stats: { total, inProgress, completed }, clients: clients }) };
        }

        if (data.action === "updateClientStatus") {
            const adminEmail = data.adminEmail;
            const clientEmail = data.clientEmail;
            const clientTimestamp = data.timestamp;
            const newStatus = data.newStatus;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized." }) };

            try {
                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { "userEmail": String(clientEmail), "timestamp": String(clientTimestamp) },
                    UpdateExpression: "set campaignStatus = :s",
                    ExpressionAttributeValues: { ":s": String(newStatus) }
                }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Status updated successfully." }) };
            } catch (updateError) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: updateError.message }) };
            }
        }

        if (data.action === "updateClientAssignment") {
            const adminEmail = data.adminEmail;
            const clientEmail = data.clientEmail;
            const clientTimestamp = data.timestamp;
            const assignedTo = data.assignedTo;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized." }) };

            try {
                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { "userEmail": String(clientEmail), "timestamp": String(clientTimestamp) },
                    UpdateExpression: "set assignedTo = :a",
                    ExpressionAttributeValues: { ":a": String(assignedTo) }
                }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Assignment updated successfully." }) };
            } catch (updateError) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: updateError.message }) };
            }
        }

        if (data.action === "getDownloadUrl") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const downloadCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: data.fileKey });
                const secureUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 60 });
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", secureUrl: secureUrl }) };
            } catch (s3Error) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Decryption failed." }) };
            }
        }

        if (data.action === "getClientStatus") {
            if (!data.userEmail) return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const scanResult = await ddbDocClient.send(new ScanCommand({
                    TableName: TABLE_NAME,
                    FilterExpression: "userEmail = :email",
                    ExpressionAttributeValues: { ":email": data.userEmail }
                }));
                const userRecords = scanResult.Items || [];

                if (userRecords.length > 0) {
                    userRecords.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                    return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", campaignStatus: userRecords[0].campaignStatus || "Pending", paymentConfirmed: userRecords[0].paymentConfirmed || false, finalFiles: userRecords[0].finalFiles || [] }) };
                } else {
                    return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", campaignStatus: "Unsubmitted", paymentConfirmed: false, finalFiles: [] }) };
                }
            } catch (dbError) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: dbError.message }) };
            }
        }

        if (data.action === "sendDocumentReminder") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const reminderHtml = `<div style="padding: 30px; font-family: sans-serif;"><h2 style="color: #4f46e5;">FiscalX Reminder</h2><p>Please upload: <strong>${data.requestedDocName}</strong></p></div>`;
                await ses.send(new SendEmailCommand({
                    Source: SENDER_EMAIL, Destination: { ToAddresses: [data.clientEmail] },
                    Message: { Subject: { Charset: "UTF-8", Data: `Document Reminder` }, Body: { Html: { Charset: "UTF-8", Data: reminderHtml } } }
                }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "updateBillingStatus") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const scanResult = await ddbDocClient.send(new ScanCommand({ TableName: TABLE_NAME, FilterExpression: "userEmail = :email", ExpressionAttributeValues: { ":email": String(data.clientEmail) } }));
                const items = scanResult.Items || [];

                for (const item of items) {
                    await ddbDocClient.send(new UpdateCommand({
                        TableName: TABLE_NAME, Key: { "userEmail": item.userEmail, "timestamp": item.timestamp },
                        UpdateExpression: "set finalFiles = :f, paymentConfirmed = :p", ExpressionAttributeValues: { ":f": data.finalFiles || [], ":p": data.paymentConfirmed || false }
                    }));
                }
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "exchangeMsCode") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const tokenResponse = await fetch(`https://login.microsoftonline.com/common/oauth2/v2.0/token`, {
                    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, code: data.code, redirect_uri: MS_REDIRECT_URI, grant_type: 'authorization_code' })
                });
                const tokenData = await tokenResponse.json();
                if (tokenData.error) throw new Error(tokenData.error);

                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME, Item: { userEmail: "SYSTEM_CONFIG", timestamp: "MICROSOFT_OUTLOOK_AUTH", msRefreshToken: tokenData.refresh_token, updatedAt: new Date().toISOString() }
                }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Outlook connected." }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "exchangeQboCode") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Staff Access." }) };

            try {
                // Dynamically use the redirectUri sent by the frontend, fallback to hardcoded if empty
                const redirectUri = data.redirectUri || QBO_REDIRECT_URI;
                console.log("QBO Exchange. ClientID present:", Boolean(QBO_CLIENT_ID), "Secret present:", Boolean(QBO_CLIENT_SECRET), "Using Redirect:", redirectUri);
                
                const authHeader = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64');
                
                const tokenResponse = await fetch(`https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, {
                    method: 'POST', 
                    headers: { 
                        'Accept': 'application/json', 
                        'Content-Type': 'application/x-www-form-urlencoded', 
                        'Authorization': `Basic ${authHeader}` 
                    },
                    body: new URLSearchParams({ 
                        code: data.code, 
                        redirect_uri: redirectUri, // <-- Using the dynamic matching URI!
                        grant_type: 'authorization_code' 
                    })
                });
                
                const tokenData = await tokenResponse.json();
                console.log("Intuit API Raw Response:", JSON.stringify(tokenData));

                if (tokenData.error || tokenData.error_description) {
                    throw new Error(`Intuit Rejected: ${tokenData.error_description || tokenData.error}`);
                }

                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME, 
                    Item: { 
                        userEmail: "SYSTEM_CONFIG", 
                        timestamp: "QUICKBOOKS_AUTH", 
                        qboRefreshToken: tokenData.refresh_token, 
                        qboRealmId: data.realmId || "UNKNOWN", 
                        updatedAt: new Date().toISOString() 
                    }
                }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "QuickBooks connected successfully!" }) };
            } catch (err) {
                console.error("Exchange QBO Code Failure:", err.message);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        if (data.action === "fetchQboInvoices") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const qboAuth = await getQboAccessToken();
                if (!qboAuth) return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "QuickBooks not connected." }) };

                const baseUrl = QBO_ENVIRONMENT === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
                const query = encodeURIComponent(`select * from Invoice where Balance > '0'`);
                const invoiceRes = await fetch(`${baseUrl}/v3/company/${qboAuth.realmId}/query?query=${query}&minorversion=65`, {
                    method: 'GET', headers: { 'Authorization': `Bearer ${qboAuth.accessToken}`, 'Accept': 'application/json' }
                });

                const invoiceData = await invoiceRes.json();
                const invoices = invoiceData.QueryResponse.Invoice || [];

                const enrichedInvoices = await Promise.all(invoices.map(async (inv) => {
                    try {
                        const ledgerRes = await ddbDocClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { "userEmail": `QBO_INVOICE#${inv.DocNumber}`, "timestamp": "LEDGER" } }));
                        return { ...inv, _ledger: ledgerRes.Item || { escalationLevel: 0, lastContactDate: "Never", isPaused: false } };
                    } catch (e) {
                        return { ...inv, _ledger: { escalationLevel: 0, lastContactDate: "Never", isPaused: false } };
                    }
                }));

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", invoices: enrichedInvoices }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        if (data.action === "sendQboReminder") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const reminderHtml = `
                    <div style="font-family: sans-serif; padding: 30px; border-radius: 16px; border: 1px solid #e2e8f0;">
                        <h2 style="color: #ef4444;">FiscalX Outstanding Invoice</h2>
                        <p>Hello ${data.customerName},</p>
                        <p>You have an outstanding balance of <strong>$${parseFloat(data.balance).toFixed(2)} CAD</strong> for Invoice #${data.docNumber}.</p>
                        <p>Please send an Interac e-Transfer to <strong>payments@fiscalx.ca</strong>.</p>
                    </div>
                `;

                await ses.send(new SendEmailCommand({
                    Source: SENDER_EMAIL, Destination: { ToAddresses: [data.customerEmail], BccAddresses: [OFFICE_EMAIL] },
                    Message: { Subject: { Charset: "UTF-8", Data: `Outstanding Balance Reminder - FiscalX` }, Body: { Html: { Charset: "UTF-8", Data: reminderHtml } } }
                }));

                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME, Key: { "userEmail": `QBO_INVOICE#${data.docNumber}`, "timestamp": "LEDGER" },
                    UpdateExpression: "set escalationLevel = :lvl, lastContactDate = :date, isPaused = if_not_exists(isPaused, :falseVal)",
                    ExpressionAttributeValues: { ":lvl": 1, ":date": new Date().toISOString().split('T')[0], ":falseVal": false }
                }));

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "toggleInvoicePause") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME, Key: { "userEmail": `QBO_INVOICE#${data.docNumber}`, "timestamp": "LEDGER" },
                    UpdateExpression: "set isPaused = :p, escalationLevel = if_not_exists(escalationLevel, :zero), lastContactDate = if_not_exists(lastContactDate, :never)",
                    ExpressionAttributeValues: { ":p": data.isPaused, ":zero": 0, ":never": "Never" }
                }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "sendQboSmsReminder") {
            const { adminEmail, customerPhone, customerName, balance, docNumber } = data;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            if (!customerPhone || !balance) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing customer phone number in QuickBooks." }) };
            }

            try {
                // 1. The Phone Scrubber: Clean dirty QBO numbers to strict E.164 format
                // Strip extensions (ext or x) and remove all non-numeric characters
                let rawDigits = String(customerPhone).toLowerCase().split('x')[0].split('ext')[0].replace(/\D/g, '');
                
                let cleanPhone = "";
                if (rawDigits.length === 10) {
                    cleanPhone = "+1" + rawDigits; // Standard Canadian/US number
                } else if (rawDigits.length === 11 && rawDigits.startsWith("1")) {
                    cleanPhone = "+" + rawDigits; // Already has the 1 country code
                } else {
                    return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: `Invalid phone format: ${customerPhone}. Must be 10 digits.` }) };
                }

                // 2. Format the SMS Message (Keep it short for telecom limits)
                const smsMessage = `FiscalX Alert: Hi ${customerName}, your invoice #${docNumber} has an outstanding balance of $${parseFloat(balance).toFixed(2)} CAD. Please remit via Interac e-Transfer to payments@fiscalx.ca to avoid service interruption.`;

                // 3. Fire the AWS SNS Cannon
                await sns.send(new PublishCommand({
                    PhoneNumber: cleanPhone,
                    Message: smsMessage,
                    MessageAttributes: {
                        'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } // Prioritizes delivery speed
                    }
                }));

                // 4. Update the Memory Ledger: Mark Level 2 Sent & Timestamp
                const today = new Date().toISOString().split('T')[0];
                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { "userEmail": `QBO_INVOICE#${docNumber}`, "timestamp": "LEDGER" },
                    UpdateExpression: "set escalationLevel = :lvl, lastContactDate = :date, isPaused = if_not_exists(isPaused, :falseVal)",
                    ExpressionAttributeValues: { ":lvl": 2, ":date": today, ":falseVal": false }
                }));

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: `SMS successfully fired to ${cleanPhone}` }) };

            } catch (err) {
                console.error("QBO SMS Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        if (data.action === "getAvailableSlots") {
            try {
                const accessToken = await getMsAccessToken();
                if (!accessToken) throw new Error("No MS Access Token");

                const scheduleRes = await fetch(`https://graph.microsoft.com/v1.0/me/calendar/getSchedule`, {
                    method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'outlook.timezone="Eastern Standard Time"' },
                    body: JSON.stringify({
                        schedules: [OFFICE_EMAIL],
                        startTime: { dateTime: `${data.bookingDate}T00:00:00`, timeZone: "Eastern Standard Time" },
                        endTime: { dateTime: `${data.bookingDate}T23:59:59`, timeZone: "Eastern Standard Time" },
                        availabilityViewInterval: 30
                    })
                });

                const scheduleData = await scheduleRes.json();
                const busyItems = (scheduleData?.value?.[0]?.scheduleItems || []).filter(item => ["busy", "oof", "tentative"].includes((item.status || "").toLowerCase()));

                const masterSlots = ["12:00 PM EST", "12:30 PM EST", "01:00 PM EST", "01:30 PM EST", "02:00 PM EST", "02:30 PM EST", "03:00 PM EST", "03:30 PM EST", "04:00 PM EST", "04:30 PM EST", "05:00 PM EST", "05:30 PM EST", "06:00 PM EST"];
                const processedSlots = masterSlots.map(timeStr => {
                    let isBusy = false; let hour = parseInt(timeStr.split(":")[0]); const minute = parseInt(timeStr.split(":")[1].substring(0, 2)); const isPm = timeStr.includes("PM");
                    if (isPm && hour !== 12) hour += 12; if (!isPm && hour === 12) hour = 0;
                    const slotDecimal = hour + (minute / 60);

                    busyItems.forEach(busy => {
                        if (busy.start && busy.end) {
                            try {
                                const startParts = (busy.start.dateTime.includes("T") ? busy.start.dateTime.split("T")[1] : busy.start.dateTime).split(":");
                                const endParts = (busy.end.dateTime.includes("T") ? busy.end.dateTime.split("T")[1] : busy.end.dateTime).split(":");
                                if (slotDecimal >= (parseInt(startParts[0]) + (parseInt(startParts[1])/60)) && slotDecimal < (parseInt(endParts[0]) + (parseInt(endParts[1])/60))) isBusy = true;
                            } catch (e) {}
                        }
                    });
                    return { time: timeStr, isAvailable: !isBusy };
                });
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", slots: processedSlots }) };
            } catch (err) {
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", slots: [{ time: "12:00 PM EST", isAvailable: true }, { time: "01:00 PM EST", isAvailable: true }] }) };
            }
        }

if (data.action === "createBooking" || data.action === "submitBooking") {
            try {
                let msEventId = null;
                const accessToken = await getMsAccessToken();
                if (accessToken) {
                    try {
                        let [hours, minutes] = data.bookingTime.replace(" EST", "").trim().split(" ")[0].split(":").map(Number);
                        const ampm = data.bookingTime.replace(" EST", "").trim().split(" ")[1];
                        if (ampm === "PM" && hours !== 12) hours += 12; if (ampm === "AM" && hours === 12) hours = 0;
                        const endMinutes = minutes + 30; const endHours = endMinutes >= 60 ? hours + 1 : hours;

                        // Check if client selected MS Teams
                        const isTeams = (data.meetingType || "").includes("Teams");
                        
                        const eventPayload = {
                            subject: `FiscalX Consultation: ${data.fullName}`,
                            body: { contentType: "HTML", content: `<p>Client Email: ${data.email}</p><p>Format: ${data.meetingType || 'In-Office'}</p>` },
                            start: { dateTime: `${data.bookingDate}T${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:00`, timeZone: "Eastern Standard Time" },
                            end: { dateTime: `${data.bookingDate}T${endHours.toString().padStart(2,'0')}:${(endMinutes%60).toString().padStart(2,'0')}:00`, timeZone: "Eastern Standard Time" },
                            attendees: [{ emailAddress: { address: data.email }, type: "required" }]
                        };

                        // The "Magic Switch" to auto-generate the MS Teams Video Link
                        if (isTeams) {
                            eventPayload.isOnlineMeeting = true;
                            eventPayload.onlineMeetingProvider = "teamsForBusiness";
                        }

                        const graphRes = await fetch(`https://graph.microsoft.com/v1.0/me/events`, {
                            method: "POST", headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                            body: JSON.stringify(eventPayload)
                        });
                        if (graphRes.ok) { msEventId = (await graphRes.json()).id; }
                    } catch (e) {}
                }

                await ddbDocClient.send(new PutCommand({ TableName: TABLE_NAME, Item: { userEmail: data.email, timestamp: new Date().toISOString(), clientName: data.fullName, bookingDate: data.bookingDate, bookingTime: data.bookingTime, msEventId: msEventId, campaignStatus: "Pending", paymentConfirmed: false } }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "rescheduleBooking") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const scanRes = await ddbDocClient.send(new ScanCommand({ TableName: TABLE_NAME, FilterExpression: "userEmail = :e AND #ts = :t", ExpressionAttributeNames: { "#ts": "timestamp" }, ExpressionAttributeValues: { ":e": String(data.clientEmail), ":t": String(data.timestamp) } }));
                const msEventId = (scanRes.Items || [])[0]?.msEventId;
                const accessToken = await getMsAccessToken();

                if (accessToken && msEventId) {
                    let [hours, minutes] = data.newTime.replace(" EST", "").trim().split(" ")[0].split(":").map(Number);
                    const ampm = data.newTime.replace(" EST", "").trim().split(" ")[1];
                    if (ampm === "PM" && hours !== 12) hours += 12; if (ampm === "AM" && hours === 12) hours = 0;
                    const endMinutes = minutes + 30; const endHours = endMinutes >= 60 ? hours + 1 : hours;

                    await fetch(`https://graph.microsoft.com/v1.0/me/events/${msEventId}`, {
                        method: "PATCH", headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({
                            start: { dateTime: `${data.newDate}T${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:00`, timeZone: "Eastern Standard Time" },
                            end: { dateTime: `${data.newDate}T${endHours.toString().padStart(2,'0')}:${(endMinutes%60).toString().padStart(2,'0')}:00`, timeZone: "Eastern Standard Time" }
                        })
                    });
                }
                
                await ddbDocClient.send(new UpdateCommand({ TableName: TABLE_NAME, Key: { "userEmail": String(data.clientEmail), "timestamp": String(data.timestamp) }, UpdateExpression: "set bookingDate = :d, bookingTime = :t", ExpressionAttributeValues: { ":d": String(data.newDate), ":t": String(data.newTime) } }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "cancelBooking") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const scanRes = await ddbDocClient.send(new ScanCommand({ TableName: TABLE_NAME, FilterExpression: "userEmail = :e AND #ts = :t", ExpressionAttributeNames: { "#ts": "timestamp" }, ExpressionAttributeValues: { ":e": String(data.clientEmail), ":t": String(data.timestamp) } }));
                const msEventId = (scanRes.Items || [])[0]?.msEventId;
                const accessToken = await getMsAccessToken();

                if (accessToken && msEventId) {
                    await fetch(`https://graph.microsoft.com/v1.0/me/events/${msEventId}`, { method: "DELETE", headers: { "Authorization": `Bearer ${accessToken}` } });
                }

                await ddbDocClient.send(new UpdateCommand({ TableName: TABLE_NAME, Key: { "userEmail": String(data.clientEmail), "timestamp": String(data.timestamp) }, UpdateExpression: "set bookingDate = :c", ExpressionAttributeValues: { ":c": "CANCELLED" } }));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

        if (data.action === "deleteClient") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR" }) };

            try {
                const targetEmailClean = String(data.clientEmail).trim().toLowerCase();
                const accessToken = await getMsAccessToken();

                if (data.timestamp) {
                    try { await ddbDocClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { "userEmail": String(data.clientEmail), "timestamp": String(data.timestamp) } })); } catch (e) {}
                }

                const scanRes = await ddbDocClient.send(new ScanCommand({ TableName: TABLE_NAME }));
                const matchingItems = (scanRes.Items || []).filter(item => String(item.userEmail || "").trim().toLowerCase() === targetEmailClean);

                for (const item of matchingItems) {
                    if (item.msEventId && accessToken) {
                        try { await fetch(`https://graph.microsoft.com/v1.0/me/events/${item.msEventId}`, { method: "DELETE", headers: { "Authorization": `Bearer ${accessToken}` } }); } catch (e) {}
                    }
                    await ddbDocClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { "userEmail": item.userEmail, "timestamp": item.timestamp } }));
                }
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR" }) };
            }
        }

// ==============================================================
        // ACTION: GENERATE MONTH-END 5% COMMISSION REPORT
        // ==============================================================
        if (data.action === "generateCommissionReport") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized." }) };

            try {
                const qboAuth = await getQboAccessToken();
                if (!qboAuth) return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "QuickBooks not connected." }) };

                // 1. Get ledgers, ignoring ones where commission was already collected
                const scanResult = await ddbDocClient.send(new ScanCommand({ TableName: TABLE_NAME }));
                const ledgers = (scanResult.Items || []).filter(item => 
                    item.userEmail && item.userEmail.startsWith("QBO_INVOICE#") && item.escalationLevel > 0 && !item.commissionCollected
                );

                if (ledgers.length === 0) {
                    return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", recoveredCount: 0, recoveredCash: 0, yourCommission: 0, paidDocNumbers: [] }) };
                }

                const docNumbers = ledgers.map(l => l.userEmail.replace("QBO_INVOICE#", ""));
                const baseUrl = QBO_ENVIRONMENT === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
                
                const docList = docNumbers.map(n => `'${n}'`).join(",");
                const query = encodeURIComponent(`select * from Invoice where DocNumber in (${docList})`);
                
                const invoiceRes = await fetch(`${baseUrl}/v3/company/${qboAuth.realmId}/query?query=${query}&minorversion=65`, {
                    method: 'GET', headers: { 'Authorization': `Bearer ${qboAuth.accessToken}`, 'Accept': 'application/json' }
                });

                const invoiceData = await invoiceRes.json();
                const qboInvoices = invoiceData.QueryResponse.Invoice || [];

                let recoveredCount = 0;
                let recoveredCash = 0;
                let paidDocNumbers = [];

                qboInvoices.forEach(inv => {
                    const balance = parseFloat(inv.Balance || 0);
                    const totalAmt = parseFloat(inv.TotalAmt || 0);
                    const amountPaid = totalAmt - balance; 
                    
                    if (amountPaid > 0) {
                        recoveredCount++;
                        recoveredCash += amountPaid;
                        paidDocNumbers.push(inv.DocNumber); // Track exactly which ones paid
                    }
                });

                const yourCommission = recoveredCash * 0.05;

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", recoveredCount, recoveredCash, yourCommission, paidDocNumbers }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION: MARK COMMISSION AS PAID (RESET METER)
        // ==============================================================
        if (data.action === "markCommissionPaid") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized." }) };

            try {
                const paidDocs = data.paidDocNumbers || [];
                for (const docNumber of paidDocs) {
                    await ddbDocClient.send(new UpdateCommand({
                        TableName: TABLE_NAME,
                        Key: { "userEmail": `QBO_INVOICE#${docNumber}`, "timestamp": "LEDGER" },
                        UpdateExpression: "set commissionCollected = :trueVal",
                        ExpressionAttributeValues: { ":trueVal": true }
                    }));
                }
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION W: THE AUTONOMOUS ROBOT (DAILY COLLECTIONS CRON JOB)
        // ==============================================================
        if (data.action === "runDailyCollections") {
            // SECURITY: Only allow this to run via internal AWS cron secret
            if (data.cronSecret !== "fiscalx_auto_8899") {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Robot Access Denied." }) };
            }

            console.log("🤖 ROBOT WAKING UP: Starting Daily Collections Scan...");

            try {
                const qboAuth = await getQboAccessToken();
                if (!qboAuth) throw new Error("Robot cannot connect to QuickBooks.");

                const baseUrl = QBO_ENVIRONMENT === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
                const query = encodeURIComponent(`select * from Invoice where Balance > '0'`);
                const invoiceRes = await fetch(`${baseUrl}/v3/company/${qboAuth.realmId}/query?query=${query}&minorversion=65`, {
                    method: 'GET', headers: { 'Authorization': `Bearer ${qboAuth.accessToken}`, 'Accept': 'application/json' }
                });

                const invoiceData = await invoiceRes.json();
                const invoices = invoiceData.QueryResponse.Invoice || [];
                const todayDate = new Date();
                const todayString = todayDate.toISOString().split('T')[0];

                let emailsSent = 0;
                let smsSent = 0;

                for (const inv of invoices) {
                    const balance = parseFloat(inv.Balance || 0);
                    const docNumber = inv.DocNumber || "N/A";
                    const customerName = inv.CustomerRef ? inv.CustomerRef.name : "Client";
                    const customerEmail = inv.BillEmail ? inv.BillEmail.Address : null;
                    const customerPhone = inv.PrimaryPhone ? inv.PrimaryPhone.FreeFormNumber : null;
                    const dueDateStr = inv.DueDate; 

                    if (!dueDateStr) continue; 

                    const dueDateObj = new Date(dueDateStr);
                    const timeDiff = todayDate.getTime() - dueDateObj.getTime();
                    const daysOverdue = Math.floor(timeDiff / (1000 * 3600 * 24));

                    if (daysOverdue < 8) continue; // RULE 1: 7-Day Grace Period.

                    const ledgerRes = await ddbDocClient.send(new GetCommand({
                        TableName: TABLE_NAME,
                        Key: { "userEmail": `QBO_INVOICE#${docNumber}`, "timestamp": "LEDGER" }
                    }));
                    const memory = ledgerRes.Item || { escalationLevel: 0, isPaused: false };

                    if (memory.isPaused) continue; // RULE 2: Kill Switch Active.

                    // LEVEL 1 (EMAIL): Day 8 to 14
                    if (daysOverdue >= 8 && memory.escalationLevel === 0) {
                        if (customerEmail) {
                            console.log(`🤖 LEVEL 1 TRIGGERED: Emailing ${customerName} for Inv #${docNumber}`);
                            const reminderHtml = `
                                <div style="font-family: sans-serif; padding: 30px; border-radius: 16px; border: 1px solid #e2e8f0;">
                                    <h2 style="color: #ef4444;">FiscalX Outstanding Invoice</h2>
                                    <p>Hello ${customerName},</p>
                                    <p>Your account has an outstanding balance of <strong>$${balance.toFixed(2)} CAD</strong> for Invoice #${docNumber}.</p>
                                    <p>Please send an Interac e-Transfer to <strong>payments@fiscalx.ca</strong> to avoid service interruption.</p>
                                </div>`;
                            
                            await ses.send(new SendEmailCommand({
                                Source: SENDER_EMAIL, Destination: { ToAddresses: [customerEmail], BccAddresses: [OFFICE_EMAIL] },
                                Message: { Subject: { Charset: "UTF-8", Data: `Outstanding Balance Reminder - FiscalX` }, Body: { Html: { Charset: "UTF-8", Data: reminderHtml } } }
                            }));
                            
                            await ddbDocClient.send(new UpdateCommand({
                                TableName: TABLE_NAME, Key: { "userEmail": `QBO_INVOICE#${docNumber}`, "timestamp": "LEDGER" },
                                UpdateExpression: "set escalationLevel = :lvl, lastContactDate = :date, isPaused = if_not_exists(isPaused, :falseVal)",
                                ExpressionAttributeValues: { ":lvl": 1, ":date": todayString, ":falseVal": false }
                            }));
                            emailsSent++;
                        }
                    }
                    // LEVEL 2 (SMS): Day 15+
                    else if (daysOverdue >= 15 && memory.escalationLevel === 1) {
                        if (customerPhone) {
                            console.log(`🤖 LEVEL 2 TRIGGERED: Texting ${customerName} for Inv #${docNumber}`);
                            let rawDigits = String(customerPhone).toLowerCase().split('x')[0].split('ext')[0].replace(/\D/g, '');
                            let cleanPhone = "";
                            if (rawDigits.length === 10) cleanPhone = "+1" + rawDigits;
                            else if (rawDigits.length === 11 && rawDigits.startsWith("1")) cleanPhone = "+" + rawDigits;

                            if (cleanPhone) {
                                const smsMessage = `FiscalX Alert: Hi ${customerName}, invoice #${docNumber} has an outstanding balance of $${balance.toFixed(2)} CAD. Please remit via Interac e-Transfer to payments@fiscalx.ca.`;
                                await sns.send(new PublishCommand({
                                    PhoneNumber: cleanPhone, Message: smsMessage,
                                    MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } }
                                }));
                                
                                await ddbDocClient.send(new UpdateCommand({
                                    TableName: TABLE_NAME, Key: { "userEmail": `QBO_INVOICE#${docNumber}`, "timestamp": "LEDGER" },
                                    UpdateExpression: "set escalationLevel = :lvl, lastContactDate = :date",
                                    ExpressionAttributeValues: { ":lvl": 2, ":date": todayString }
                                }));
                                smsSent++;
                            }
                        }
                    }

                    // ANTI-SPAM BATCHING: Sleep for 1 second between clients
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                console.log(`🤖 ROBOT SLEEPING: Sent ${emailsSent} Emails and ${smsSent} Texts.`);
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", emails: emailsSent, sms: smsSent }) };

            } catch (err) {
                console.error("Robot Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION: FISCALBOT AI RECEPTIONIST (AMAZON NOVA 2 LITE)
        // ==============================================================
        if (data.action === "chatWithFiscalBot") {
            const userMessage = data.message || "";
            const conversationHistory = data.history || []; // Array of { role: "user" | "assistant", content: [{ text: "..." }] }
            
            if (!userMessage) return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "No message provided." }) };

            try {
                // Prepare the message payload for Amazon Nova
                const formattedMessages = [...conversationHistory];
                formattedMessages.push({
                    role: "user",
                    content: [{ text: userMessage }]
                });

                const systemPrompt = `You are FiscalBot, the professional AI Receptionist for FiscalX Professional Corporation, a premium Canadian accounting firm based in the Greater Toronto Area (GTA), led by Wasim Kadri, CPA.

YOUR CORE DIRECTIVES:
1. Be polite, concise, and highly professional. Keep answers to 2-3 short paragraphs maximum.
2. Answer Canadian Revenue Agency (CRA) tax questions accurately.
3. NEVER invent tax laws. NEVER invent fake phone numbers, emails, or prices.
4. Lead Generation Goal: Always guide warm leads to book a consultation or leave their contact details.

FIRM DETAILS & CONTACTS:
- Office Location: Greater Toronto Area (GTA), Ontario. We offer both in-office appointments and 100% remote/virtual tax filing across Canada.
- Phone Number: (647) 450-9235 (Available Mon-Fri, 11:00 AM - 6:00 PM EST).
- General Email: info@fiscalx.ca
- Booking & Client Portal Link: https://www.fiscalx.ca/dashboard/
- General Contact Page: https://www.fiscalx.ca/contact-us/
- Appointment Policy: By appointment only. No unannounced walk-ins so Wasim can give every client 100% dedicated attention.

PAYMENTS & BILLING (How clients pay us):
- Interac e-Transfer: Send payments directly to payments@fiscalx.ca (Auto-deposit is enabled).
- Cash: Accepted in-person at our office during your scheduled appointment.
- STRICT PAYMENT RULE: We ONLY accept Interac e-Transfer and Cash. We DO NOT accept credit cards  or checks under any circumstances.
- Pricing: We do not provide flat quotes over chat because every tax file is unique. Instruct the user to book a consultation for a precise quote.

SERVICES OFFERED:
- PERSONAL TAX (T1): Self-Employed & Gig Economy (Uber, DoorDash), Prior Year Taxes, Remote Tax Filing, CRA Audits/Reviews, Tax Adjustments, Tax Planning, Disability Tax Credit (DTC), New Immigrants, Voluntary Disclosure (VDP), and Debt/Credit Counselling.
- CORPORATE TAX (T2): Corporate Tax Returns, Financial Statements, Cloud Bookkeeping, Incorporation/New Business Registration, and Corporate Dissolutions.

PROCESS & TIMELINES:
- How to submit documents: Clients can securely upload tax slips (T4s, T5s, receipts, CRA letters) anytime at https://www.fiscalx.ca/dashboard/
- Turnaround Time: Standard T1 Personal returns take 24–48 hours after all documents are uploaded. Corporate T2 returns take 3–5 business days.
- CRA Audits/Letters: Tell panicked clients that Wasim Kadri, CPA specializes in CRA representation and Voluntary Disclosures, and advise them to upload the CRA letter to their dashboard or book an urgent consultation.

IF ASKED ABOUT DEADLINES:
- T1 Personal: April 30th (June 15th for Self-Employed, but balance due April 30th).
- T2 Corporate: Filing due 6 months after fiscal year-end; tax balance due 2 or 3 months post year-end.

Always close your responses by asking if they would like the link to book a consultation with Wasim Kadri, CPA.`;

                const novaPayload = {
                    system: [{ text: systemPrompt }],
                    messages: formattedMessages,
                    inferenceConfig: {
                        maxTokens: 500,
                        temperature: 0.3,
                        topP: 0.9
                    }
                };

                const command = new InvokeModelCommand({
                    modelId: "us.amazon.nova-2-lite-v1:0",
                    contentType: "application/json",
                    accept: "application/json",
                    body: JSON.stringify(novaPayload)
                });

                const bedrockResponse = await bedrock.send(command);
                
                // Decode the response (Bedrock returns a Uint8Array)
                const decodedResponseBody = new TextDecoder().decode(bedrockResponse.body);
                const responseJson = JSON.parse(decodedResponseBody);
                
                // Nova messages API returns output in responseJson.output.message.content[0].text
                const aiReply = responseJson.output.message.content[0].text;

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", reply: aiReply }) };

            } catch (err) {
                console.error("FiscalBot Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: "FiscalBot is currently sleeping. Please try again later." }) };
            }
        }

        // ==============================================================
        // ACTION D: PROCESS THE STANDARD CONTACT INTAKE FORM
        // ==============================================================
        const fullName = data.fullName || "Valued Client"; 
        const email = data.email || data.userEmail || "Unknown Email"; 
        const service = data.service || "General Inquiry"; 
        const message = data.message || "None provided";

        // SECURE CHECK: Only fire this if it's explicitly a contact form!
        if (data.action === "submitContact" || (!data.action && fullName && email !== "Unknown Email")) {
            const intakeHtml = `
                <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                    <h2 style="color: #0284c7; margin-bottom: 4px;">FiscalX Intake Portal</h2>
                    <p style="font-size: 14px; color: #64748b; margin-top: 0;">New Consultation Request Received</p>
                    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <tr><td style="padding: 12px; font-weight: bold; width: 140px; border-bottom: 1px solid #e2e8f0; background-color: #f1f5f9;">Name:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${fullName}</td></tr>
                        <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; background-color: #f1f5f9;">Email:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${email}</td></tr>
                        <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; background-color: #f1f5f9;">Service:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${service}</td></tr>
                        <tr><td style="padding: 12px; font-weight: bold; background-color: #f1f5f9;">Message:</td><td style="padding: 12px;">${message}</td></tr>
                    </table>
                </div>
            `;
            await ses.send(new SendEmailCommand({
                Source: SENDER_EMAIL, Destination: { ToAddresses: [OFFICE_EMAIL] },
                Message: { Subject: { Charset: "UTF-8", Data: `[New Lead] Consultation Request from ${fullName}` }, Body: { Html: { Charset: "UTF-8", Data: intakeHtml } } }
            }));
            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: `Thank you. Your request is queued.` }) };
        }

        // Default catch-all if no valid action was provided
        return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };

    } catch (error) {
        console.error("Error processing request:", error);
        return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: error.message }) };
    }
};