import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
// NEW: Import Cognito SDK to dynamically check user groups in real-time
import { CognitoIdentityProviderClient, AdminListGroupsForUserCommand } from "@aws-sdk/client-cognito-identity-provider";

const s3 = new S3Client({ region: "ca-central-1" });
const ses = new SESClient({ region: "ca-central-1" });
const ddbClient = new DynamoDBClient({ region: "ca-central-1" });
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const cognito = new CognitoIdentityProviderClient({ region: "ca-central-1" });

const BUCKET_NAME = "fiscalx-document-vault-673098723249";
const TABLE_NAME = "fiscalx-client-onboarding";
const USER_POOL_ID = "ca-central-1_omKzLVfdI"; // From your live Cognito URL!
const SENDER_EMAIL = "info@fiscalx.ca"; 
const OFFICE_EMAIL = "info@fiscalx.ca"; 

// NEW: Helper function to query Cognito in real-time and check if user is Staff
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
                    rentalIncome: rentalIncome, childCareBenefit: childCareBenefit
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
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Software:</td><td style="padding: 8px 0; text-transform: capitalize;">${corporateInfo.software || "N/A"}</td></tr>
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
        // ACTION E: FETCH CRM DATA FOR ADMIN PORTAL
        // ==============================================================
        if (data.action === "getCrmData") {
            const adminEmail = data.adminEmail;

            // FIXED: Dynamically check groups using Cognito SDK! No hardcoded lists!
            const isAuthorized = await isStaff(adminEmail);
            if (!isAuthorized) {
                return { statusCode: 403, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Unauthorized Backend Access." }) };
            }

            const scanParams = { TableName: TABLE_NAME };
            const scanResult = await ddbDocClient.send(new ScanCommand(scanParams));
            const clients = scanResult.Items || [];

            const total = clients.length;
            const inProgress = clients.filter(c => c.campaignStatus === 'Pending' || c.campaignStatus === 'In Progress').length;
            const completed = clients.filter(c => c.campaignStatus === 'Completed').length;

            return {
                statusCode: 200, headers: headers,
                body: JSON.stringify({ status: "SUCCESS", stats: { total, inProgress, completed }, clients: clients })
            };
        }

        // ==============================================================
        // ACTION F: UPDATE CLIENT KANBAN STATUS (FIXED SCHEMA)
        // ==============================================================
        if (data.action === "updateClientStatus") {
            const adminEmail = data.adminEmail;
            const clientEmail = data.clientEmail;
            const clientTimestamp = data.timestamp;
            const newStatus = data.newStatus;

            // FIXED: Dynamically check groups using Cognito SDK! No hardcoded lists!
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

            // FIXED: Dynamically check groups using Cognito SDK! No hardcoded lists!
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