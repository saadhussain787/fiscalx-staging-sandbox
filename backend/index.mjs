import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient, AdminListGroupsForUserCommand } from "@aws-sdk/client-cognito-identity-provider";

const s3 = new S3Client({ region: "ca-central-1" });
const ses = new SESClient({ region: "ca-central-1" });
const ddbClient = new DynamoDBClient({ region: "ca-central-1" });
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const cognito = new CognitoIdentityProviderClient({ region: "ca-central-1" });

const BUCKET_NAME = "fiscalx-document-vault-673098723249";
const TABLE_NAME = "fiscalx-client-onboarding";
const USER_POOL_ID = "ca-central-1_omKzLVfdI"; 
const SENDER_EMAIL = "info@fiscalx.ca"; 
const OFFICE_EMAIL = "info@fiscalx.ca"; 
const MS_CLIENT_ID = "359dc7f8-359d-47ab-abcf-c0129559aacb";
const MS_TENANT_ID = "8793dd74-ad92-4663-a197-95c9e0955c5e";
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET; 
const MS_REDIRECT_URI = "https://www.fiscalx.ca/admin/";

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

// Global Helper Function: Fetches a fresh 60-min Access Token from Microsoft Graph API
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

export const handler = async (event) => {
    console.log("Incoming Event Payload:", JSON.stringify(event));

    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    };

    if (event.requestContext && event.requestContext.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: headers, body: JSON.stringify({ message: "CORS preflight successful" }) };
    }

    try {
        const data = JSON.parse(event.body || "{}");

        // ==============================================================
        // ACTION A: GENERATE SECURE S3 PRESIGNED UPLOAD URL
        // ==============================================================
        if (data.action === "getUploadUrl") {
            const fileName = data.fileName;
            const fileType = data.fileType;
            const userEmail = data.userEmail;

            const fileKey = `clients/${userEmail}/${Date.now()}-${fileName}`;
            const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey, ContentType: fileType });
            const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

            return {
                statusCode: 200, headers: headers,
                body: JSON.stringify({ status: "SUCCESS", uploadUrl: uploadUrl, fileKey: fileKey })
            };
        }

        // ==============================================================
        // ACTION B: NOTIFY UPLOAD COMPLETE
        // ==============================================================
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

                        const updateParams = {
                            TableName: TABLE_NAME,
                            Key: { 
                                userEmail: latestRecord.userEmail,
                                timestamp: latestRecord.timestamp
                            },
                            UpdateExpression: "set uploadedFiles = :f",
                            ExpressionAttributeValues: { ":f": existingFiles }
                        };
                        await ddbDocClient.send(new UpdateCommand(updateParams));
                        console.log(`Successfully attached file ${cleanFileName} to active card for ${userEmail}`);
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

            const sesCommand = new SendEmailCommand({
                Source: SENDER_EMAIL, Destination: { ToAddresses: [OFFICE_EMAIL] },
                Message: { Subject: { Charset: "UTF-8", Data: `[Vault Alert] New Client Upload from ${userEmail}` }, Body: { Html: { Charset: "UTF-8", Data: emailHtml } } }
            });
            await ses.send(sesCommand);

            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS" }) };
        }

        // ==============================================================
        // ACTION C: SUBMIT CANADIAN TAX ORGANIZER
        // ==============================================================
        if (data.action === "submitTaxOrganizer") {
            const {
                userEmail = "Unknown", taxType = "T1 Personal", craConsent = "Not Provided", howHeard = "Not Specified",
                personalInfo = {}, familyMembers = [], statusInCanada = {}, ontarioResidency = [], milestones = {},
                selfEmployed = {}, rentalIncome = {}, childCareBenefit = {}, corporateInfo = {}, notes = "None provided.", uploadedFiles = [] 
            } = data;

            const isT2 = taxType.includes("T2");
            const combinedName = isT2 ? corporateInfo.corpName : `${personalInfo.firstName || ""} ${personalInfo.middleName || ""} ${personalInfo.lastName || ""}`.trim();
            const timestamp = new Date().toISOString();

            let activeStatus = "Pending";
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
                    activeStatus = userRecords[0].campaignStatus || "Pending";
                }
            } catch (dbError) {
                console.error("Failed to inherit active status:", dbError);
            }

            const ddbParams = {
                TableName: TABLE_NAME,
                Item: {
                    userEmail: userEmail, timestamp: timestamp, taxType: taxType, craConsent: craConsent, clientName: combinedName,
                    amountOwed: "0.00", amountCollected: "0.00", campaignStatus: activeStatus, howHeard: howHeard, notes: notes,
                    uploadedFiles: uploadedFiles, personalInfo: personalInfo, corporateInfo: corporateInfo, statusInCanada: statusInCanada,
                    familyMembers: familyMembers, ontarioResidency: ontarioResidency, milestones: milestones, selfEmployed: selfEmployed,
                    rentalIncome: rentalIncome, childCareBenefit: childCareBenefit,
                    paymentConfirmed: false,
                    finalFiles: []
                }
            };
            await ddbDocClient.send(new PutCommand(ddbParams));

            const csvRows = [ ["Section", "Field", "Value"] ];
            csvRows.push(
                ["System", "Tax Type", taxType], ["System", "CRA Consent", craConsent], ["System", "Client Email", userEmail],
                ["System", "Client Notes", notes], ["System", "How Heard", howHeard]
            );

            if (isT2) {
                csvRows.push(
                    ["T2 Corporate", "Corporate Name", corporateInfo.corpName || "N/A"], ["T2 Corporate", "Business Number", corporateInfo.businessNumber || "N/A"],
                    ["T2 Corporate", "Date of Incorporation", corporateInfo.incDate || "N/A"], ["T2 Corporate", "Fiscal Year End", corporateInfo.fiscalYearEnd || "N/A"],
                    ["T2 Corporate", "Bookkeeping Software", corporateInfo.software || "N/A"], ["T2 Corporate", "Primary Industry", corporateInfo.industry || "N/A"],
                    ["T2 Remittance", "GST/HST Registered", corporateInfo.remittance?.gst || "no"], ["T2 Remittance", "Payroll Registered", corporateInfo.remittance?.payroll || "no"]
                );
                if (corporateInfo.directors && corporateInfo.directors.length > 0) {
                    corporateInfo.directors.forEach((d, index) => {
                        csvRows.push(["Director " + (index + 1), "Name", d.name], ["Director " + (index + 1), "SIN", d.sin], ["Director " + (index + 1), "Share %", d.share], ["Director " + (index + 1), "Role", d.role]);
                    });
                }
            } else {
                csvRows.push(
                    ["T1 Personal", "Full Name", combinedName || "N/A"], ["T1 Personal", "SIN", personalInfo.sin || "N/A"], ["T1 Personal", "Telephone", personalInfo.telephone || "N/A"], ["T1 Personal", "Address", personalInfo.address || "N/A"], ["T1 Personal", "US Citizen", personalInfo.usCitizen || "N/A"], ["T1 Personal", "Marital Status", personalInfo.maritalStatus || "N/A"], ["T1 Personal", "Spousal Income ($)", personalInfo.spousalIncome || "0.00"],
                    ["T1 Status", "Immigration Status", statusInCanada.status || "N/A"], ["T1 Status", "Entry Date", statusInCanada.entryDate || "N/A"]
                );
                if (familyMembers.length > 0) {
                    familyMembers.forEach((mem, index) => {
                        csvRows.push(["Dependent " + (index + 1), "Name", mem.name], ["Dependent " + (index + 1), "SIN", mem.sin], ["Dependent " + (index + 1), "DOB", mem.dob], ["Dependent " + (index + 1), "Relationship", mem.relationship], ["Dependent " + (index + 1), "Disability", mem.disability]);
                    });
                }
                if (ontarioResidency.length > 0) {
                    ontarioResidency.forEach((res, index) => {
                        csvRows.push(["Residency " + (index + 1), "Months", res.months], ["Residency " + (index + 1), "Address", res.address], ["Residency " + (index + 1), "Landlord", res.landlord]);
                    });
                }
                csvRows.push(
                    ["Milestones", "Elections Canada", milestones.electionsCanada || "no"], ["Milestones", "Direct Deposit Changed", milestones.directDeposit || "no"], ["Milestones", "Tuition Paid", milestones.tuition || "no"], ["Milestones", "RRSP Contribution", milestones.rrsp || "no"], ["Milestones", "Charitable Donations", milestones.charitable || "no"], ["Milestones", "Stock/Crypto", milestones.crypto || "no"], ["Milestones", "Daycare", milestones.daycare || "no"], ["Milestones", "Work From Home", milestones.workFromHome || "no"], ["Milestones", "Purchased Home", milestones.purchasedHome || "no"]
                );
                csvRows.push(["UBER (T2125)", "Active", selfEmployed.active || "no"]);
                if (selfEmployed.active === "yes") {
                    csvRows.push(
                        ["UBER (T2125)", "HST No", selfEmployed.hstNo || "N/A"], ["UBER (T2125)", "Access Code", selfEmployed.accessCode || "N/A"], ["UBER (T2125)", "Period From", selfEmployed.periodFrom || "N/A"], ["UBER (T2125)", "Period To", selfEmployed.periodTo || "N/A"], ["UBER (T2125)", "Total KMs Driven", selfEmployed.totalKms || "0"], ["UBER (T2125)", "Business KMs", selfEmployed.businessKms || "0"],
                        ["UBER (T2125)", "Fuel", selfEmployed.expenses?.fuel || "0"], ["UBER (T2125)", "Repairs", selfEmployed.expenses?.repairs || "0"], ["UBER (T2125)", "Insurance", selfEmployed.expenses?.insurance || "0"], ["UBER (T2125)", "License", selfEmployed.expenses?.license || "0"], ["UBER (T2125)", "Interest", selfEmployed.expenses?.interest || "0"], ["UBER (T2125)", "Carwash", selfEmployed.expenses?.carwash || "0"],
                        ["UBER (T2125)", "Parking", selfEmployed.expenses?.parking || "0"], ["UBER (T2125)", "Tolls", selfEmployed.expenses?.tolls || "0"], ["UBER (T2125)", "Tickets", selfEmployed.expenses?.tickets || "0"], ["UBER (T2125)", "Phone Line $", selfEmployed.expenses?.phone || "0"], ["UBER (T2125)", "Supplies", selfEmployed.expenses?.supplies || "0"], ["UBER (T2125)", "Meals", selfEmployed.expenses?.meals || "0"]
                    );
                }
                csvRows.push(["Rental (T776)", "Active", rentalIncome.active || "no"]);
                if (rentalIncome.active === "yes") {
                    csvRows.push(["Rental (T776)", "Address", rentalIncome.address || "N/A"], ["Rental (T776)", "Gross Income", rentalIncome.grossIncome || "0"], ["Rental (T776)", "Percentage Rented", rentalIncome.percentageRented || "100"]);
                    if (rentalIncome.coOwners && rentalIncome.coOwners.length > 0) {
                        rentalIncome.coOwners.forEach((owner, index) => {
                            csvRows.push(["Rental Co-Owner " + (index + 1), "Name", owner.name], ["Rental Co-Owner " + (index + 1), "SIN", owner.sin], ["Rental Co-Owner " + (index + 1), "Share %", owner.share], ["Rental Co-Owner " + (index + 1), "Address", owner.address]);
                        });
                    }
                    csvRows.push(
                        ["Rental (T776)", "Insurance", rentalIncome.expenses?.insurance || "0"], ["Rental (T776)", "Mortgage Interest", rentalIncome.expenses?.interest || "0"], ["Rental (T776)", "Bank Charges", rentalIncome.expenses?.bankCharges || "0"], ["Rental (T776)", "Office", rentalIncome.expenses?.office || "0"], ["Rental (T776)", "Professional Fees", rentalIncome.expenses?.professional || "0"], ["Rental (T776)", "Management", rentalIncome.expenses?.management || "0"], ["Rental (T776)", "Repairs", rentalIncome.expenses?.repairs || "0"], ["Rental (T776)", "Property Tax", rentalIncome.expenses?.propertyTax || "0"], ["Rental (T776)", "Utilities", rentalIncome.expenses?.utilities || "0"]
                    );
                }
                csvRows.push(["CCB", "Active", childCareBenefit.active || "no"]);
                if (childCareBenefit.active === "yes") {
                    csvRows.push(["CCB", "Marriage Date", childCareBenefit.marriageDate || "N/A"], ["CCB", "Status Change Date", childCareBenefit.statusChangeDate || "N/A"], ["CCB", "Resident Year", childCareBenefit.worldIncome?.becameResidentYear || "0"], ["CCB", "1 Year Before", childCareBenefit.worldIncome?.oneYearBefore || "0"], ["CCB", "2 Years Before", childCareBenefit.worldIncome?.twoYearsBefore || "0"]);
                }
            }
            
            const csvString = csvRows.map(row => row.map(cell => `"${(cell||'').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
            const csvKey = `clients/${userEmail}/${Date.now()}-${taxType.substring(0,2)}-Organizer.csv`;
            await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: csvKey, Body: csvString, ContentType: "text/csv" }));
            const excelDownloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: csvKey }), { expiresIn: 86400 });

            let documentLinksHtml = "";
            if (uploadedFiles.length > 0) {
                documentLinksHtml = `<div style="margin-top: 30px; background-color: #f1f5f9; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
                                     <h3 style="color: #0f172a; margin-top: 0; font-size: 15px;">📁 Attached Client Documents (${uploadedFiles.length})</h3>
                                     <ul style="list-style-type: none; padding-left: 0; margin-bottom: 0;">`;
                for (const file of uploadedFiles) {
                    const docUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: file.fileKey }), { expiresIn: 86400 });
                    documentLinksHtml += `<li style="margin-bottom: 10px; font-size: 13px;">📄 <strong>${file.fileName}</strong> - <a href="${docUrl}" target="_blank" style="color: #2563eb; text-decoration: none; font-weight: bold;">[Download]</a></li>`;
                }
                documentLinksHtml += `</ul></div>`;
            }

            let specificHtmlBody = "";
            if (isT2) {
                let directorRows = (corporateInfo.directors || []).map(d => `<tr><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${d.name}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${d.sin}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${d.share}%</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${d.role}</td></tr>`).join("");
                if (!directorRows) directorRows = `<tr><td colspan='4' style='padding:6px; text-align:center;'>None Declared</td></tr>`;

                specificHtmlBody = `
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">1. Corporate Baseline Information</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569; width: 140px;">Corporate Name:</td><td style="padding: 8px 0; font-weight: bold;">${corporateInfo.corpName || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Business Number:</td><td style="padding: 8px 0; font-family: monospace;">${corporateInfo.businessNumber || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Inc. Date:</td><td style="padding: 8px 0;">${corporateInfo.incDate || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Fiscal Year-End:</td><td style="padding: 8px 0;">${corporateInfo.fiscalYearEnd || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; text-transform: capitalize;">${corporateInfo.software || "N/A"}</td></tr>
                            <tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Industry:</td><td style="padding: 8px 0;">${corporateInfo.industry || "N/A"}</td></tr>
                        </table>
                    </div>
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">2. Tax Remittance Accounts</h3>
                        <p style="font-size: 13px;"><strong>GST/HST (RT):</strong> ${(corporateInfo.remittance?.gst || "no").toUpperCase()} | <strong>Payroll (RP):</strong> ${(corporateInfo.remittance?.payroll || "no").toUpperCase()}</p>
                    </div>
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">3. Corporate Directors & Shareholders</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
                            <thead><tr style="background-color: #f8fafc; color: #475569;"><th style="padding: 8px;">Name</th><th style="padding: 8px;">SIN</th><th style="padding: 8px;">Share %</th><th style="padding: 8px;">Role</th></tr></thead>
                            <tbody>${directorRows}</tbody>
                        </table>
                    </div>
                `;
            } else {
                let familyRows = familyMembers.map(m => `<tr><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${m.name}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${m.sin}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${m.dob}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9; text-transform: capitalize;">${m.relationship}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9; text-transform: uppercase;">${m.disability}</td></tr>`).join("");
                let residencyRows = ontarioResidency.map(r => `<tr><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${r.months} Mos</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${r.address}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${r.landlord}</td></tr>`).join("");
                const selfEmployedHtml = selfEmployed.active === "yes" ? `<div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;"><h3 style="color: #059669; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">UBER/Lyft (T2125)</h3><p style="font-size: 12px;"><strong>Total KMs:</strong> ${selfEmployed.totalKms || "0"} | <strong>Business KMs:</strong> ${selfEmployed.businessKms || "0"}</p></div>` : "";
                const rentalHtml = rentalIncome.active === "yes" ? `<div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;"><h3 style="color: #0284c7; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">Rental Income (T776)</h3><p style="font-size: 12px;"><strong>Address:</strong> ${rentalIncome.address || "N/A"} | <strong>Gross Income:</strong> $${rentalIncome.grossIncome || "0.00"}</p></div>` : "";
                
                specificHtmlBody = `
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">1. Personal Profile</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569; width: 140px;">Name:</td><td style="padding: 8px 0; font-weight: bold;">${combinedName || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">9-Digit SIN:</td><td style="padding: 8px 0; font-family: monospace;">${personalInfo.sin || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Telephone:</td><td style="padding: 8px 0;">${personalInfo.telephone || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Marital Status:</td><td style="padding: 8px 0; text-transform: capitalize;">${personalInfo.maritalStatus || "N/A"}</td></tr>
                            <tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Spousal Net Inc.:</td><td style="padding: 8px 0; font-weight: bold; color: #059669;">$${personalInfo.spousalIncome || "0.00"}</td></tr>
                        </table>
                    </div>
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;"><h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">2. Family Dependents</h3><table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;"><thead><tr style="background-color: #f8fafc; color: #475569;"><th style="padding: 8px;">Name</th><th style="padding: 8px;">SIN</th><th style="padding: 8px;">DOB</th><th style="padding: 8px;">Relation</th><th style="padding: 8px;">DTC</th></tr></thead><tbody>${familyRows || "<tr><td colspan='5' style='padding:6px; text-align:center;'>None</td></tr>"}</tbody></table></div>
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;"><h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">3. Status & Ontario Properties</h3><p style="font-size: 13px;"><strong>Immigration:</strong> ${statusInCanada.status || "N/A"} | <strong>Entry Date:</strong> ${statusInCanada.entryDate || "N/A"}</p><table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; border: 1px solid #e2e8f0; margin-top: 10px;"><thead><tr style="background-color: #f1f5f9;"><th style="padding: 8px;">Months</th><th style="padding: 8px;">Address</th><th style="padding: 8px;">Landlord/City</th></tr></thead><tbody>${residencyRows || "<tr><td colspan='3' style='padding:6px; text-align:center;'>None</td></tr>"}</tbody></table></div>
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;"><h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">4. Milestones Disclosures</h3><table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;"><tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0; width: 75%;">Auth. Elections Canada?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.electionsCanada || "no").toUpperCase()}</td></tr><tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Direct Deposit Changed?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.directDeposit || "no").toUpperCase()}</td></tr><tr><td style="padding: 10px 0;">Purchased a new home in this tax year?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.purchasedHome || "no").toUpperCase()}</td></tr></table></div>
                    ${selfEmployedHtml}
                    ${rentalHtml}
                `;
            }

            const organizerHtml = `
                <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 650px; margin: 0 auto; border: 1px solid #e2e8f0;">
                    <h2 style="color: #059669; margin-bottom: 4px;">FiscalX Professional Portal</h2>
                    <p style="font-size: 14px; color: #64748b; margin-top: 0;">Completed Tax Organizer (${taxType})</p>
                    <div style="margin-top: 15px; padding: 12px; background-color: #fef3c7; border: 1px solid #fde68a; border-radius: 8px;">
                        <p style="font-size: 12px; color: #92400e; margin: 0;"><strong>Client Email:</strong> ${userEmail}</p>
                        <p style="font-size: 12px; color: #92400e; margin: 5px 0 0 0;"><strong>CRA Auth:</strong> ${craConsent}</p>
                    </div>
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${excelDownloadUrl}" target="_blank" style="background-color: #059669; color: #ffffff; text-decoration: none; padding: 14px 28px; font-weight: bold; font-size: 14px; border-radius: 8px;">📊 Download Full Data as Excel (.CSV)</a>
                    </div>
                    ${specificHtmlBody}
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">Additional Notes</h3>
                        <p style="font-size: 13px; line-height: 1.5; color: #475569; margin-top: 10px;">${notes || "None provided."}</p>
                    </div>
                    ${documentLinksHtml}
                </div>
            `;

            const sesOrganizerCommand = new SendEmailCommand({
                Source: SENDER_EMAIL, Destination: { ToAddresses: [OFFICE_EMAIL] },
                Message: { Subject: { Charset: "UTF-8", Data: `[${taxType}] Complete Onboarding from ${combinedName || userEmail}` }, Body: { Html: { Charset: "UTF-8", Data: organizerHtml } } }
            });
            await ses.send(sesOrganizerCommand);

            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Your onboarding organizer and files have been securely compiled and delivered." }) };
        }

// ==============================================================
        // ACTION E: FETCH CRM DATA FOR ADMIN PORTAL (FILTERS SYSTEM_CONFIG)
        // ==============================================================
        if (data.action === "getCrmData") {
            const adminEmail = data.adminEmail;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            const scanParams = { TableName: TABLE_NAME };
            const scanResult = await ddbDocClient.send(new ScanCommand(scanParams));
            
            // FILTER OUT INTERNAL SYSTEM CONFIG CARDS
            const clients = (scanResult.Items || []).filter(c => c.userEmail !== "SYSTEM_CONFIG");

            const total = clients.length;
            const inProgress = clients.filter(c => c.campaignStatus === 'Pending' || c.campaignStatus === 'In Progress').length;
            const completed = clients.filter(c => c.campaignStatus === 'Completed').length;

            return {
                statusCode: 200, headers: headers,
                body: JSON.stringify({ status: "SUCCESS", stats: { total, inProgress, completed }, clients: clients })
            };
        }

        // ==============================================================
        // ACTION F: UPDATE CLIENT KANBAN STATUS
        // ==============================================================
        if (data.action === "updateClientStatus") {
            const adminEmail = data.adminEmail;
            const clientEmail = data.clientEmail;
            const clientTimestamp = data.timestamp;
            const newStatus = data.newStatus;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            if (!clientEmail || !clientTimestamp) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing required keys: Email or Timestamp." }) };
            }

            try {
                const updateParams = {
                    TableName: TABLE_NAME,
                    Key: { 
                        "userEmail": String(clientEmail),
                        "timestamp": String(clientTimestamp) 
                    },
                    UpdateExpression: "set campaignStatus = :s",
                    ExpressionAttributeValues: { ":s": String(newStatus) },
                    ReturnValues: "UPDATED_NEW"
                };

                await ddbDocClient.send(new UpdateCommand(updateParams));
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Status updated successfully." }) };
            
            } catch (updateError) {
                console.error("DynamoDB Update Error:", updateError);
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Database update failed: " + updateError.message }) };
            }
        }

        // ==============================================================
        // ACTION G: GENERATE SECURE DOWNLOAD URL FOR ADMINS
        // ==============================================================
        if (data.action === "getDownloadUrl") {
            const adminEmail = data.adminEmail;
            const fileKey = data.fileKey;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Decryption Request." }) };
            }

            if (!fileKey) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "No file key provided." }) };
            }

            try {
                const downloadCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey });
                const secureUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 60 });

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", secureUrl: secureUrl }) };
            } catch (s3Error) {
                console.error("S3 Decryption Error:", s3Error);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Failed to unlock document vault." }) };
            }
        }

        // ==============================================================
        // ACTION H: FETCH A SINGLE CLIENT'S STATUS FOR THEIR DASHBOARD
        // ==============================================================
        if (data.action === "getClientStatus") {
            const userEmail = data.userEmail;

            if (!userEmail) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing user email." }) };
            }

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
                    const latestStatus = userRecords[0].campaignStatus || "Pending";
                    const isPaid = userRecords[0].paymentConfirmed || false;
                    const finalReturns = userRecords[0].finalFiles || [];
                    
                    return { statusCode: 200, headers: headers, body: JSON.stringify({ 
                        status: "SUCCESS", 
                        campaignStatus: latestStatus,
                        paymentConfirmed: isPaid,
                        finalFiles: finalReturns
                    }) };
                } else {
                    return { statusCode: 200, headers: headers, body: JSON.stringify({ 
                        status: "SUCCESS", 
                        campaignStatus: "Unsubmitted",
                        paymentConfirmed: false,
                        finalFiles: []
                    }) };
                }
            } catch (dbError) {
                console.error("Failed to fetch client status:", dbError);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: dbError.message }) };
            }
        }

        // ==============================================================
        // ACTION I: SEND DOCUMENT REQUEST EMAIL REMINDERS
        // ==============================================================
        if (data.action === "sendDocumentReminder") {
            const adminEmail = data.adminEmail;
            const clientEmail = data.clientEmail;
            const clientName = data.clientName || "Client";
            const requestedDocName = data.requestedDocName;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            if (!clientEmail || !requestedDocName) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing clientEmail or requestedDocName." }) };
            }

            try {
                const reminderHtml = `
                    <div style="font-family: sans-serif; padding: 30px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                        <h2 style="color: #4f46e5; margin-bottom: 4px;">FiscalX Professional Corporation</h2>
                        <p style="font-size: 14px; color: #64748b; margin-top: 0;">Secure Document Reminder</p>
                        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                        <p style="font-size: 15px; line-height: 1.6;">Hello ${clientName},</p>
                        <p style="font-size: 15px; line-height: 1.6;">Wasim Kadri, CPA is currently actively preparing your tax file. To proceed with your return, we securely require the following document:</p>
                        
                        <div style="margin: 25px 0; padding: 20px; background-color: #fffbeb; border: 1px solid #fef3c7; border-radius: 12px; text-align: center;">
                            <span style="font-size: 16px; font-weight: bold; color: #b45309;">⚠️ Required Document: ${requestedDocName}</span>
                        </div>
                        
                        <p style="font-size: 15px; line-height: 1.6;">Please click the secure button below to log into your portal. Once logged in, scroll to the bottom of your screen to the <strong>"Secure Document Upload Center"</strong> to transmit your document directly into our encrypted S3 vault.</p>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="https://www.fiscalx.ca/dashboard/" target="_blank" style="background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 14px 28px; font-weight: bold; font-size: 14px; border-radius: 8px;">Log In & Upload Document</a>
                        </div>
                        
                        <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 20px;">
                            This is an automated transmission on behalf of Wasim Kadri, CPA (FiscalX). Please do not reply directly to this email.
                        </p>
                    </div>
                `;

                const sesCommand = new SendEmailCommand({
                    Source: SENDER_EMAIL,
                    Destination: { ToAddresses: [clientEmail] },
                    Message: {
                        Subject: { Charset: "UTF-8", Data: `[Action Required] Document Reminder for Your FiscalX Tax File` },
                        Body: { Html: { Charset: "UTF-8", Data: reminderHtml } }
                    }
                });
                await ses.send(sesCommand);

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Reminder sent successfully." }) };
            } catch (err) {
                console.error("Failed to send document reminder:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION J: UPDATE BILLING STATUS & FINAL RETURNS (CASHFLOW SECURE)
        // ==============================================================
        if (data.action === "updateBillingStatus") {
            const { adminEmail, clientEmail, timestamp, finalFiles = [], paymentConfirmed = false } = data;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }
            if (!clientEmail) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing client identity keys." }) };
            }

            try {
                const scanParams = {
                    TableName: TABLE_NAME,
                    FilterExpression: "userEmail = :email",
                    ExpressionAttributeValues: { ":email": String(clientEmail) }
                };
                const scanResult = await ddbDocClient.send(new ScanCommand(scanParams));
                const items = scanResult.Items || [];

                for (const item of items) {
                    const updateParams = {
                        TableName: TABLE_NAME,
                        Key: { "userEmail": item.userEmail, "timestamp": item.timestamp },
                        UpdateExpression: "set finalFiles = :f, paymentConfirmed = :p",
                        ExpressionAttributeValues: { ":f": finalFiles, ":p": paymentConfirmed }
                    };
                    await ddbDocClient.send(new UpdateCommand(updateParams));
                }

                if (paymentConfirmed === true) {
                    const unlockHtml = `
                        <div style="font-family: sans-serif; padding: 30px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                            <h2 style="color: #10b981; margin-bottom: 4px;">FiscalX Professional Corporation</h2>
                            <p style="font-size: 14px; color: #64748b; margin-top: 0;">Payment Confirmed - Documents Unlocked</p>
                            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                            <p style="font-size: 15px;">Hello,</p>
                            <p style="font-size: 15px;">Thank you for your payment. Wasim Kadri, CPA has finalized your tax return.</p>
                            <div style="margin: 25px 0; padding: 20px; background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px; text-align: center;">
                                <span style="font-size: 16px; font-weight: bold; color: #065f46;">✅ Your secure tax documents are now unlocked and ready for download.</span>
                            </div>
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="https://www.fiscalx.ca/dashboard/" target="_blank" style="background-color: #10b981; color: #ffffff; text-decoration: none; padding: 14px 28px; font-weight: bold; font-size: 14px; border-radius: 8px;">Log In & Download Returns</a>
                            </div>
                        </div>
                    `;
                    const sesCommand = new SendEmailCommand({
                        Source: SENDER_EMAIL,
                        Destination: { ToAddresses: [clientEmail] },
                        Message: {
                            Subject: { Charset: "UTF-8", Data: `[FiscalX] Payment Confirmed - Your Tax Returns are Unlocked` },
                            Body: { Html: { Charset: "UTF-8", Data: unlockHtml } }
                        }
                    });
                    await ses.send(sesCommand);
                }

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Billing status updated successfully across all records." }) };
            } catch (updateError) {
                console.error("DynamoDB Billing Update Error:", updateError);
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Database update failed: " + updateError.message }) };
            }
        }

        // ==============================================================
        // ACTION K: CLIENT-SAFE DOWNLOAD URL GENERATOR
        // ==============================================================
        if (data.action === "getClientDownloadUrl") {
            const userEmail = data.userEmail;
            const fileKey = data.fileKey;

            if (!userEmail || !fileKey) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing required fields." }) };
            }

            if (!fileKey.includes(`clients/${userEmail}/`)) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "You are not authorized to download this file." }) };
            }

            try {
                const downloadCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey });
                const secureUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 60 });
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", secureUrl: secureUrl }) };
            } catch (s3Error) {
                console.error("Client S3 Decryption Error:", s3Error);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Failed to unlock document vault." }) };
            }
        }

        // ==============================================================
        // ACTION O: EXCHANGE MICROSOFT OAUTH CODE FOR REFRESH TOKEN
        // ==============================================================
        if (data.action === "exchangeMsCode") {
            const isAuthorized = await isStaff(data.adminEmail);
            if (!isAuthorized) return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized." }) };

            const msCode = data.code;
            if (!msCode) return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing Microsoft Authorization Code." }) };

            try {
                const tokenResponse = await fetch(`https://login.microsoftonline.com/common/oauth2/v2.0/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: MS_CLIENT_ID,
                        client_secret: MS_CLIENT_SECRET,
                        code: msCode,
                        redirect_uri: MS_REDIRECT_URI,
                        grant_type: 'authorization_code'
                    })
                });

                const tokenData = await tokenResponse.json();
                
                if (tokenData.error) {
                    throw new Error(tokenData.error_description || tokenData.error);
                }

                const refreshToken = tokenData.refresh_token;
                
                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: {
                        userEmail: "SYSTEM_CONFIG",
                        timestamp: "MICROSOFT_OUTLOOK_AUTH",
                        msRefreshToken: refreshToken,
                        updatedAt: new Date().toISOString()
                    }
                }));

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Outlook connected and token secured." }) };

            } catch (err) {
                console.error("Microsoft Token Exchange Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION P: GET REAL-TIME CALENDAR AVAILABILITY FROM MICROSOFT
        // ==============================================================
        if (data.action === "getAvailableSlots") {
            const bookingDate = data.bookingDate; // YYYY-MM-DD
            if (!bookingDate) return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing bookingDate." }) };

            const fallbackSlots = [
                { time: "12:00 PM EST", isAvailable: true }, { time: "12:30 PM EST", isAvailable: true },
                { time: "01:00 PM EST", isAvailable: true }, { time: "01:30 PM EST", isAvailable: true },
                { time: "02:00 PM EST", isAvailable: true }, { time: "02:30 PM EST", isAvailable: true },
                { time: "03:00 PM EST", isAvailable: true }, { time: "03:30 PM EST", isAvailable: true },
                { time: "04:00 PM EST", isAvailable: true }, { time: "04:30 PM EST", isAvailable: true },
                { time: "05:00 PM EST", isAvailable: true }, { time: "05:30 PM EST", isAvailable: true },
                { time: "06:00 PM EST", isAvailable: true }
            ];

            try {
                const accessToken = await getMsAccessToken();

                if (!accessToken) {
                    console.log("No MS Access Token available. Returning open fallback slots.");
                    return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", slots: fallbackSlots }) };
                }

                const startDateTime = `${bookingDate}T00:00:00`;
                const endDateTime = `${bookingDate}T23:59:59`;

                const scheduleRes = await fetch(`https://graph.microsoft.com/v1.0/me/calendar/getSchedule`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'outlook.timezone="Eastern Standard Time"'
                    },
                    body: JSON.stringify({
                        schedules: [OFFICE_EMAIL],
                        startTime: { dateTime: startDateTime, timeZone: "Eastern Standard Time" },
                        endTime: { dateTime: endDateTime, timeZone: "Eastern Standard Time" },
                        availabilityViewInterval: 30
                    })
                });

                const scheduleData = await scheduleRes.json();
                const rawItems = scheduleData?.value?.[0]?.scheduleItems || [];

                const busyItems = rawItems.filter(item => {
                    const status = (item.status || "").toLowerCase();
                    return status === "busy" || status === "oof" || status === "tentative";
                });

                const masterSlots = [
                    "12:00 PM EST", "12:30 PM EST", 
                    "01:00 PM EST", "01:30 PM EST", 
                    "02:00 PM EST", "02:30 PM EST", 
                    "03:00 PM EST", "03:30 PM EST", 
                    "04:00 PM EST", "04:30 PM EST", 
                    "05:00 PM EST", "05:30 PM EST", 
                    "06:00 PM EST"
                ];

                const processedSlots = masterSlots.map(timeStr => {
                    let isBusy = false;
                    const parts = timeStr.split(":");
                    let hour = parseInt(parts[0]);
                    const minute = parseInt(parts[1].substring(0, 2));
                    const isPm = timeStr.includes("PM");

                    if (isPm && hour !== 12) hour += 12;
                    if (!isPm && hour === 12) hour = 0;

                    const slotDecimal = hour + (minute / 60);

                    busyItems.forEach(busy => {
                        if (busy.start && busy.start.dateTime && busy.end && busy.end.dateTime) {
                            try {
                                const startTimeStr = busy.start.dateTime.includes("T") ? busy.start.dateTime.split("T")[1] : busy.start.dateTime;
                                const endTimeStr = busy.end.dateTime.includes("T") ? busy.end.dateTime.split("T")[1] : busy.end.dateTime;

                                const startParts = startTimeStr.split(":");
                                const endParts = endTimeStr.split(":");

                                const startDecimal = parseInt(startParts[0]) + (parseInt(startParts[1]) / 60);
                                const endDecimal = parseInt(endParts[0]) + (parseInt(endParts[1]) / 60);

                                if (slotDecimal >= startDecimal && slotDecimal < endDecimal) {
                                    isBusy = true;
                                }
                            } catch (parseErr) {
                                console.error("Error parsing busy item time:", parseErr);
                            }
                        }
                    });

                    return { time: timeStr, isAvailable: !isBusy };
                });

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", slots: processedSlots }) };

            } catch (err) {
                console.error("Microsoft Graph Schedule Error:", err);
                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", slots: fallbackSlots }) };
            }
        }

        // ==============================================================
        // ACTION L: SUBMIT NEW BOOKING (CAPTURES msEventId FOR OUTLOOK SYNC)
        // ==============================================================
        if (data.action === "createBooking" || data.action === "submitBooking") {
            const userEmail = data.email || data.userEmail;
            const userName = data.fullName || data.userName || "Valued Client";
            const bookingDate = data.bookingDate;
            const bookingTime = data.bookingTime;
            const meetingType = data.meetingType || "MS Teams Consultation";
            const phone = data.phone || "Not Provided";

            if (!userEmail || !bookingDate || !bookingTime) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing required booking details." }) };
            }

            try {
                let msEventId = null;
                const accessToken = await getMsAccessToken();

                if (accessToken) {
                    try {
                        const timeParts = bookingTime.replace(" EST", "").trim().split(" ");
                        let [hours, minutes] = timeParts[0].split(":").map(Number);
                        const ampm = timeParts[1];

                        if (ampm === "PM" && hours !== 12) hours += 12;
                        if (ampm === "AM" && hours === 12) hours = 0;

                        const startHourStr = hours.toString().padStart(2, '0');
                        const startMinStr = minutes.toString().padStart(2, '0');

                        let endHours = hours;
                        let endMinutes = minutes + 30;
                        if (endMinutes >= 60) {
                            endHours += 1;
                            endMinutes -= 60;
                        }
                        const endHourStr = endHours.toString().padStart(2, '0');
                        const endMinStr = endMinutes.toString().padStart(2, '0');

                        const startDateTime = `${bookingDate}T${startHourStr}:${startMinStr}:00`;
                        const endDateTime = `${bookingDate}T${endHourStr}:${endMinStr}:00`;

                        const eventPayload = {
                            subject: `FiscalX Consultation: ${userName}`,
                            body: {
                                contentType: "HTML",
                                content: `<p><strong>Client Name:</strong> ${userName}</p><p><strong>Client Email:</strong> ${userEmail}</p><p><strong>Phone:</strong> ${phone}</p><p><strong>Format:</strong> ${meetingType}</p>`
                            },
                            start: { dateTime: startDateTime, timeZone: "Eastern Standard Time" },
                            end: { dateTime: endDateTime, timeZone: "Eastern Standard Time" },
                            location: { displayName: meetingType },
                            attendees: [
                                { emailAddress: { address: userEmail, name: userName }, type: "required" }
                            ]
                        };

                        const graphRes = await fetch(`https://graph.microsoft.com/v1.0/me/events`, {
                            method: "POST",
                            headers: {
                                "Authorization": `Bearer ${accessToken}`,
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify(eventPayload)
                        });

                        if (graphRes.ok) {
                            const graphData = await graphRes.json();
                            msEventId = graphData.id || null;
                            console.log("Successfully created event on Wasim's Outlook Calendar. EventID:", msEventId);
                        } else {
                            const errData = await graphRes.json();
                            console.error("Microsoft Graph Event Creation Error:", JSON.stringify(errData));
                        }
                    } catch (msErr) {
                        console.error("Failed to post event to Microsoft Graph:", msErr);
                    }
                }

                const timestamp = new Date().toISOString();
                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: {
                        userEmail: userEmail,
                        timestamp: timestamp,
                        clientName: userName,
                        bookingDate: bookingDate,
                        bookingTime: bookingTime,
                        meetingType: meetingType,
                        phone: phone,
                        msEventId: msEventId,
                        campaignStatus: "Pending",
                        paymentConfirmed: false,
                        finalFiles: [],
                        uploadedFiles: []
                    }
                }));

                const emailHtml = `
                    <div style="font-family: sans-serif; padding: 30px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                        <h2 style="color: #059669; margin-bottom: 4px;">FiscalX Professional Corporation</h2>
                        <p style="font-size: 14px; color: #64748b; margin-top: 0;">Consultation Confirmed</p>
                        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                        <p style="font-size: 15px;">Hello ${userName},</p>
                        <p style="font-size: 15px;">Your consultation with Wasim Kadri, CPA has been successfully reserved.</p>
                        <div style="margin: 25px 0; padding: 20px; background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px;">
                            <p style="font-size: 14px; color: #065f46; margin: 0 0 8px 0;"><strong>📅 Date:</strong> ${bookingDate}</p>
                            <p style="font-size: 14px; color: #065f46; margin: 0 0 8px 0;"><strong>⏰ Time:</strong> ${bookingTime}</p>
                            <p style="font-size: 14px; color: #065f46; margin: 0;"><strong>💻 Format:</strong> ${meetingType}</p>
                        </div>
                        <p style="font-size: 14px; color: #475569;">If you need to upload tax documents prior to our meeting, please log into your <a href="https://www.fiscalx.ca/dashboard/" style="color: #059669; font-weight: bold;">Client Portal</a>.</p>
                    </div>
                `;

                const sesCommand = new SendEmailCommand({
                    Source: SENDER_EMAIL,
                    Destination: { ToAddresses: [userEmail], BccAddresses: [OFFICE_EMAIL] },
                    Message: {
                        Subject: { Charset: "UTF-8", Data: `[FiscalX] Consultation Confirmed for ${bookingDate} @ ${bookingTime}` },
                        Body: { Html: { Charset: "UTF-8", Data: emailHtml } }
                    }
                });
                await ses.send(sesCommand);

                return {
                    statusCode: 200, headers: headers,
                    body: JSON.stringify({ status: "SUCCESS", message: "Booking confirmed, Outlook calendar synced, and confirmation email delivered.", msEventId: msEventId })
                };

            } catch (err) {
                console.error("Booking Creation Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION M: RESCHEDULE BOOKING (MOVES EXISTING OUTLOOK EVENT)
        // ==============================================================
        if (data.action === "rescheduleBooking") {
            const { adminEmail, clientEmail, timestamp, newDate, newTime } = data;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            if (!clientEmail || !timestamp || !newDate || !newTime) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Missing required reschedule parameters." }) };
            }

            try {
                // Fetch active record to get msEventId
                const scanRes = await ddbDocClient.send(new ScanCommand({
                    TableName: TABLE_NAME,
                    FilterExpression: "userEmail = :e AND #ts = :t",
                    ExpressionAttributeNames: { "#ts": "timestamp" },
                    ExpressionAttributeValues: { ":e": String(clientEmail), ":t": String(timestamp) }
                }));
                const existingItem = (scanRes.Items || [])[0];
                const msEventId = existingItem?.msEventId;

                const accessToken = await getMsAccessToken();

                if (accessToken) {
                    const timeParts = newTime.replace(" EST", "").trim().split(" ");
                    let [hours, minutes] = timeParts[0].split(":").map(Number);
                    const ampm = timeParts[1];

                    if (ampm === "PM" && hours !== 12) hours += 12;
                    if (ampm === "AM" && hours === 12) hours = 0;

                    const startHourStr = hours.toString().padStart(2, '0');
                    const startMinStr = minutes.toString().padStart(2, '0');

                    let endHours = hours;
                    let endMinutes = minutes + 30;
                    if (endMinutes >= 60) {
                        endHours += 1;
                        endMinutes -= 60;
                    }
                    const endHourStr = endHours.toString().padStart(2, '0');
                    const endMinStr = endMinutes.toString().padStart(2, '0');

                    const startDateTime = `${newDate}T${startHourStr}:${startMinStr}:00`;
                    const endDateTime = `${newDate}T${endHourStr}:${endMinStr}:00`;

                    if (msEventId) {
                        // PATCH existing event to MOVE it on Outlook (Frees old slot!)
                        await fetch(`https://graph.microsoft.com/v1.0/me/events/${msEventId}`, {
                            method: "PATCH",
                            headers: {
                                "Authorization": `Bearer ${accessToken}`,
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                start: { dateTime: startDateTime, timeZone: "Eastern Standard Time" },
                                end: { dateTime: endDateTime, timeZone: "Eastern Standard Time" }
                            })
                        });
                    } else {
                        // If no eventId exists, create a fresh one
                        const graphRes = await fetch(`https://graph.microsoft.com/v1.0/me/events`, {
                            method: "POST",
                            headers: {
                                "Authorization": `Bearer ${accessToken}`,
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                subject: `FiscalX Consultation: ${clientEmail}`,
                                start: { dateTime: startDateTime, timeZone: "Eastern Standard Time" },
                                end: { dateTime: endDateTime, timeZone: "Eastern Standard Time" },
                                attendees: [{ emailAddress: { address: clientEmail }, type: "required" }]
                            })
                        });
                        if (graphRes.ok) {
                            const newEv = await graphRes.json();
                            await ddbDocClient.send(new UpdateCommand({
                                TableName: TABLE_NAME,
                                Key: { "userEmail": String(clientEmail), "timestamp": String(timestamp) },
                                UpdateExpression: "set msEventId = :id",
                                ExpressionAttributeValues: { ":id": newEv.id }
                            }));
                        }
                    }
                }

                // Update DynamoDB record
                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { "userEmail": String(clientEmail), "timestamp": String(timestamp) },
                    UpdateExpression: "set bookingDate = :d, bookingTime = :t",
                    ExpressionAttributeValues: { ":d": String(newDate), ":t": String(newTime) }
                }));

                const rescheduleHtml = `
                    <div style="font-family: sans-serif; padding: 30px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                        <h2 style="color: #4f46e5; margin-bottom: 4px;">FiscalX Professional Corporation</h2>
                        <p style="font-size: 14px; color: #64748b; margin-top: 0;">Appointment Rescheduled</p>
                        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                        <p style="font-size: 15px;">Hello,</p>
                        <p style="font-size: 15px;">Your consultation with Wasim Kadri, CPA has been rescheduled to a new time slot:</p>
                        <div style="margin: 25px 0; padding: 20px; background-color: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 12px;">
                            <p style="font-size: 15px; color: #5b21b6; margin: 0 0 8px 0;"><strong>📅 New Date:</strong> ${newDate}</p>
                            <p style="font-size: 15px; color: #5b21b6; margin: 0;"><strong>⏰ New Time:</strong> ${newTime}</p>
                        </div>
                        <p style="font-size: 14px; color: #475569;">If this time does not work for you, please reply to this email or visit your <a href="https://www.fiscalx.ca/dashboard/" style="color: #4f46e5; font-weight: bold;">Client Portal</a>.</p>
                    </div>
                `;

                await ses.send(new SendEmailCommand({
                    Source: SENDER_EMAIL,
                    Destination: { ToAddresses: [clientEmail], BccAddresses: [OFFICE_EMAIL] },
                    Message: {
                        Subject: { Charset: "UTF-8", Data: `[FiscalX] Consultation Rescheduled to ${newDate} @ ${newTime}` },
                        Body: { Html: { Charset: "UTF-8", Data: rescheduleHtml } }
                    }
                }));

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Booking rescheduled, Outlook updated, and client notified." }) };
            } catch (err) {
                console.error("Reschedule Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION N: CANCEL BOOKING (DELETES OUTLOOK EVENT & FREES SLOT)
        // ==============================================================
        if (data.action === "cancelBooking") {
            const { adminEmail, clientEmail, timestamp } = data;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            try {
                // Delete Event from Outlook if msEventId exists
                const scanRes = await ddbDocClient.send(new ScanCommand({
                    TableName: TABLE_NAME,
                    FilterExpression: "userEmail = :e AND #ts = :t",
                    ExpressionAttributeNames: { "#ts": "timestamp" },
                    ExpressionAttributeValues: { ":e": String(clientEmail), ":t": String(timestamp) }
                }));
                const existingItem = (scanRes.Items || [])[0];
                const msEventId = existingItem?.msEventId;

                if (msEventId) {
                    const accessToken = await getMsAccessToken();
                    if (accessToken) {
                        try {
                            await fetch(`https://graph.microsoft.com/v1.0/me/events/${msEventId}`, {
                                method: "DELETE",
                                headers: { "Authorization": `Bearer ${accessToken}` }
                            });
                            console.log("Successfully deleted event from Outlook:", msEventId);
                        } catch (delErr) { console.error("Outlook Event Delete Error:", delErr); }
                    }
                }

                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { "userEmail": String(clientEmail), "timestamp": String(timestamp) },
                    UpdateExpression: "set bookingDate = :c",
                    ExpressionAttributeValues: { ":c": "CANCELLED" }
                }));

                const cancelHtml = `
                    <div style="font-family: sans-serif; padding: 30px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                        <h2 style="color: #ef4444; margin-bottom: 4px;">FiscalX Professional Corporation</h2>
                        <p style="font-size: 14px; color: #64748b; margin-top: 0;">Appointment Cancellation</p>
                        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                        <p style="font-size: 15px;">Hello,</p>
                        <p style="font-size: 15px;">Your scheduled consultation with FiscalX Professional Corporation has been cancelled.</p>
                        <p style="font-size: 14px; color: #475569;">If you believe this is an error or would like to rebook, please contact us at <a href="mailto:info@fiscalx.ca" style="color: #ef4444; font-weight: bold;">info@fiscalx.ca</a>.</p>
                    </div>
                `;

                await ses.send(new SendEmailCommand({
                    Source: SENDER_EMAIL,
                    Destination: { ToAddresses: [clientEmail], BccAddresses: [OFFICE_EMAIL] },
                    Message: {
                        Subject: { Charset: "UTF-8", Data: `[FiscalX] Consultation Cancellation Notice` },
                        Body: { Html: { Charset: "UTF-8", Data: cancelHtml } }
                    }
                }));

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Booking cancelled, Outlook event removed, and client notified." }) };
            } catch (err) {
                console.error("Cancel Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION Q: PERMANENTLY DELETE CLIENT CARD FROM DYNAMODB
        // ==============================================================
        if (data.action === "deleteClient") {
            const { adminEmail, clientEmail, timestamp } = data;

            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            try {
                // Delete Outlook Event if msEventId exists
                const scanRes = await ddbDocClient.send(new ScanCommand({
                    TableName: TABLE_NAME,
                    FilterExpression: "userEmail = :e AND #ts = :t",
                    ExpressionAttributeNames: { "#ts": "timestamp" },
                    ExpressionAttributeValues: { ":e": String(clientEmail), ":t": String(timestamp) }
                }));
                const item = (scanRes.Items || [])[0];

                if (item && item.msEventId) {
                    const accessToken = await getMsAccessToken();
                    if (accessToken) {
                        try {
                            await fetch(`https://graph.microsoft.com/v1.0/me/events/${item.msEventId}`, {
                                method: "DELETE",
                                headers: { "Authorization": `Bearer ${accessToken}` }
                            });
                        } catch (e) { console.error("Outlook Event Delete Error:", e); }
                    }
                }

                // Delete item from DynamoDB
                await ddbDocClient.send(new DeleteCommand({
                    TableName: TABLE_NAME,
                    Key: { "userEmail": String(clientEmail), "timestamp": String(timestamp) }
                }));

                return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Record permanently deleted." }) };

            } catch (err) {
                console.error("Delete Record Error:", err);
                return { statusCode: 500, headers: headers, body: JSON.stringify({ status: "ERROR", message: err.message }) };
            }
        }

        // ==============================================================
        // ACTION D: PROCESS THE STANDARD CONTACT INTAKE FORM
        // ==============================================================
        const fullName = data.fullName; const email = data.email; const service = data.service; const message = data.message;
        const intakeHtml = `
            <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                <h2 style="color: #0284c7; margin-bottom: 4px;">FiscalX Intake Portal</h2>
                <p style="font-size: 14px; color: #64748b; margin-top: 0;">New Consultation Request Received</p>
                <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <tr><td style="padding: 12px; font-weight: bold; width: 140px; border-bottom: 1px solid #e2e8f0; background-color: #f1f5f9;">Name:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${fullName}</td></tr>
                    <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; background-color: #f1f5f9;">Email:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${email}</td></tr>
                    <tr><td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; background-color: #f1f5f9;">Service:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${service}</td></tr>
                    <tr><td style="padding: 12px; font-weight: bold; background-color: #f1f5f9;">Message:</td><td style="padding: 12px;">${message || "N/A"}</td></tr>
                </table>
            </div>
        `;
        const sesIntakeCommand = new SendEmailCommand({
            Source: SENDER_EMAIL, Destination: { ToAddresses: [OFFICE_EMAIL] },
            Message: { Subject: { Charset: "UTF-8", Data: `[New Lead] Consultation Request from ${fullName}` }, Body: { Html: { Charset: "UTF-8", Data: intakeHtml } } }
        });
        await ses.send(sesIntakeCommand);

        return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: `Thank you. Your request is queued.` }) };

    } catch (error) {
        console.error("Error processing request:", error);
        return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: error.message }) };
    }
};