import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const s3 = new S3Client({ region: "ca-central-1" });
const ses = new SESClient({ region: "ca-central-1" });

const BUCKET_NAME = "fiscalx-document-vault-673098723249";
const SENDER_EMAIL = "info@fiscalx.ca"; 
const OFFICE_EMAIL = "info@fiscalx.ca"; 

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
        // ACTION B: NOTIFY UPLOAD COMPLETE (For the Bottom Standalone Vault)
        // ==============================================================
        if (data.action === "notifyUploadComplete") {
            const fileKey = data.fileKey;
            const userEmail = data.userEmail;
            const fileName = fileKey.split("/").pop(); 

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
                        <tr><td style="padding: 12px; font-weight: bold; color: #475569; border-bottom: 1px solid #e2e8f0;">File Name:</td><td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${fileName.substring(13)}</td></tr>
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
        // ACTION C: SUBMIT CANADIAN TAX ORGANIZER (Full HTML & Complete CSV)
        // ==============================================================
        if (data.action === "submitTaxOrganizer") {
            const {
                userEmail = "Unknown",
                howHeard = "Not Specified",
                personalInfo = {},
                familyMembers = [],
                statusInCanada = {},
                ontarioResidency = [],
                milestones = {},
                selfEmployed = {},
                rentalIncome = {},
                childCareBenefit = {},
                notes = "None provided.",
                uploadedFiles = [] 
            } = data;

            // 1. GENERATE THE COMPREHENSIVE EXCEL CSV DATA
            const csvRows = [
                ["Section", "Field", "Value"]
            ];
            
            // Personal & Status
            csvRows.push(
                ["Personal", "Full Name", personalInfo.fullName || "N/A"],
                ["Personal", "SIN", personalInfo.sin || "N/A"],
                ["Personal", "Email", userEmail],
                ["Personal", "Telephone", personalInfo.telephone || "N/A"],
                ["Personal", "Address", personalInfo.address || "N/A"],
                ["Personal", "Marital Status", personalInfo.maritalStatus || "N/A"],
                ["Personal", "Spousal Income ($)", personalInfo.spousalIncome || "N/A"],
                ["Personal", "How Heard", howHeard],
                ["Status", "Immigration Status", statusInCanada.status || "N/A"],
                ["Status", "Entry Date", statusInCanada.entryDate || "N/A"]
            );

            // Dynamic Dependents Loop
            if (familyMembers.length > 0) {
                familyMembers.forEach((mem, index) => {
                    csvRows.push(["Dependent " + (index + 1), "Name", mem.name]);
                    csvRows.push(["Dependent " + (index + 1), "SIN", mem.sin]);
                    csvRows.push(["Dependent " + (index + 1), "DOB", mem.dob]);
                    csvRows.push(["Dependent " + (index + 1), "Relationship", mem.relationship]);
                    csvRows.push(["Dependent " + (index + 1), "Disability Approved", mem.disability]);
                });
            } else {
                csvRows.push(["Dependents", "Declared", "None"]);
            }

            // Dynamic Residency Loop
            if (ontarioResidency.length > 0) {
                ontarioResidency.forEach((res, index) => {
                    csvRows.push(["Residency " + (index + 1), "Months", res.months]);
                    csvRows.push(["Residency " + (index + 1), "Address", res.address]);
                    csvRows.push(["Residency " + (index + 1), "Landlord", res.landlord]);
                });
            } else {
                csvRows.push(["Residency", "Ontario Addresses", "None"]);
            }

            // Milestones
            csvRows.push(
                ["Milestones", "Elections Canada", milestones.electionsCanada || "no"],
                ["Milestones", "Direct Deposit Changed", milestones.directDeposit || "no"],
                ["Milestones", "Tuition Paid", milestones.tuition || "no"],
                ["Milestones", "RRSP Contribution", milestones.rrsp || "no"],
                ["Milestones", "Charitable Donations", milestones.charitable || "no"],
                ["Milestones", "Stock/Crypto", milestones.crypto || "no"],
                ["Milestones", "Daycare", milestones.daycare || "no"],
                ["Milestones", "Work From Home", milestones.workFromHome || "no"],
                ["Milestones", "Purchased Home", milestones.purchasedHome || "no"]
            );

            // Uber/Lyft
            csvRows.push(["UBER (T2125)", "Active", selfEmployed.active || "no"]);
            if (selfEmployed.active === "yes") {
                csvRows.push(
                    ["UBER (T2125)", "HST No", selfEmployed.hstNo || "N/A"],
                    ["UBER (T2125)", "Access Code", selfEmployed.accessCode || "N/A"],
                    ["UBER (T2125)", "Period From", selfEmployed.periodFrom || "N/A"],
                    ["UBER (T2125)", "Period To", selfEmployed.periodTo || "N/A"],
                    ["UBER (T2125)", "Total KMs Driven", selfEmployed.totalKms || "0"],
                    ["UBER (T2125)", "Business KMs", selfEmployed.businessKms || "0"],
                    ["UBER (T2125)", "Fuel", selfEmployed.expenses?.fuel || "0"],
                    ["UBER (T2125)", "Repairs", selfEmployed.expenses?.repairs || "0"],
                    ["UBER (T2125)", "Insurance", selfEmployed.expenses?.insurance || "0"],
                    ["UBER (T2125)", "License", selfEmployed.expenses?.license || "0"],
                    ["UBER (T2125)", "Interest", selfEmployed.expenses?.interest || "0"],
                    ["UBER (T2125)", "Carwash", selfEmployed.expenses?.carwash || "0"],
                    ["UBER (T2125)", "Parking", selfEmployed.expenses?.parking || "0"],
                    ["UBER (T2125)", "Tolls", selfEmployed.expenses?.tolls || "0"],
                    ["UBER (T2125)", "Tickets (Non-deduct)", selfEmployed.expenses?.tickets || "0"],
                    ["UBER (T2125)", "Phone", selfEmployed.expenses?.phone || "0"],
                    ["UBER (T2125)", "Supplies", selfEmployed.expenses?.supplies || "0"],
                    ["UBER (T2125)", "Meals", selfEmployed.expenses?.meals || "0"]
                );
            }

            // Rental Income
            csvRows.push(["Rental (T776)", "Active", rentalIncome.active || "no"]);
            if (rentalIncome.active === "yes") {
                csvRows.push(["Rental (T776)", "Address", rentalIncome.address || "N/A"]);
                csvRows.push(["Rental (T776)", "Gross Income", rentalIncome.grossIncome || "0"]);
                csvRows.push(["Rental (T776)", "Percentage Rented", rentalIncome.percentageRented || "100"]);
                
                // Co-Owners Dynamic Loop
                if (rentalIncome.coOwners && rentalIncome.coOwners.length > 0) {
                    rentalIncome.coOwners.forEach((owner, index) => {
                        csvRows.push(["Rental Co-Owner " + (index + 1), "Name", owner.name]);
                        csvRows.push(["Rental Co-Owner " + (index + 1), "SIN", owner.sin]);
                        csvRows.push(["Rental Co-Owner " + (index + 1), "Share %", owner.share]);
                        csvRows.push(["Rental Co-Owner " + (index + 1), "Address", owner.address]);
                    });
                } else {
                    csvRows.push(["Rental (T776)", "Ownership", "100% Sole Owner"]);
                }

                csvRows.push(
                    ["Rental (T776)", "Insurance", rentalIncome.expenses?.insurance || "0"],
                    ["Rental (T776)", "Mortgage Interest", rentalIncome.expenses?.interest || "0"],
                    ["Rental (T776)", "Bank Charges", rentalIncome.expenses?.bankCharges || "0"],
                    ["Rental (T776)", "Office", rentalIncome.expenses?.office || "0"],
                    ["Rental (T776)", "Professional Fees", rentalIncome.expenses?.professional || "0"],
                    ["Rental (T776)", "Management", rentalIncome.expenses?.management || "0"],
                    ["Rental (T776)", "Repairs", rentalIncome.expenses?.repairs || "0"],
                    ["Rental (T776)", "Property Tax", rentalIncome.expenses?.propertyTax || "0"],
                    ["Rental (T776)", "Utilities", rentalIncome.expenses?.utilities || "0"]
                );
            }

            // Child Care
            csvRows.push(["CCB", "Active", childCareBenefit.active || "no"]);
            if (childCareBenefit.active === "yes") {
                csvRows.push(
                    ["CCB", "Marriage Date", childCareBenefit.marriageDate || "N/A"],
                    ["CCB", "Status Change Date", childCareBenefit.statusChangeDate || "N/A"],
                    ["CCB", "Resident Year", childCareBenefit.worldIncome?.becameResidentYear || "0"],
                    ["CCB", "1 Year Before", childCareBenefit.worldIncome?.oneYearBefore || "0"],
                    ["CCB", "2 Years Before", childCareBenefit.worldIncome?.twoYearsBefore || "0"]
                );
            }

            csvRows.push(["Notes", "Client Notes", notes]);
            
            const csvString = csvRows.map(row => row.map(cell => `"${(cell||'').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
            
            const csvKey = `clients/${userEmail}/${Date.now()}-TaxOrganizer.csv`;
            const csvUploadCommand = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: csvKey, Body: csvString, ContentType: "text/csv" });
            await s3.send(csvUploadCommand);
            const csvDownloadCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: csvKey });
            const excelDownloadUrl = await getSignedUrl(s3, csvDownloadCommand, { expiresIn: 86400 });

            // 2. GENERATE S3 DOWNLOAD LINKS FOR ATTACHED DOCUMENTS
            let documentLinksHtml = "";
            if (uploadedFiles.length > 0) {
                documentLinksHtml = `<div style="margin-top: 30px; background-color: #f1f5f9; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
                                     <h3 style="color: #0f172a; margin-top: 0; font-size: 15px;">📁 Attached Client Documents (${uploadedFiles.length})</h3>
                                     <ul style="list-style-type: none; padding-left: 0; margin-bottom: 0;">`;
                
                for (const file of uploadedFiles) {
                    const docCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: file.fileKey });
                    const docUrl = await getSignedUrl(s3, docCommand, { expiresIn: 86400 });
                    documentLinksHtml += `<li style="margin-bottom: 10px; font-size: 13px;">
                        📄 <strong>${file.fileName}</strong> - <a href="${docUrl}" target="_blank" style="color: #2563eb; text-decoration: none; font-weight: bold;">[Download]</a>
                    </li>`;
                }
                documentLinksHtml += `</ul></div>`;
            } else {
                documentLinksHtml = `<div style="margin-top: 30px; background-color: #f1f5f9; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
                                     <p style="font-size: 13px; color: #64748b; margin: 0;">No documents were attached to this submission.</p></div>`;
            }

            // 3. REBUILD THE FULL HTML EMAIL PREVIEW
            let familyRows = familyMembers.map(m => `<tr><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${m.name}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${m.sin}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${m.dob}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9; text-transform: capitalize;">${m.relationship}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9; text-transform: uppercase;">${m.disability}</td></tr>`).join("");
            let residencyRows = ontarioResidency.map(r => `<tr><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${r.months} Mos</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${r.address}</td><td style="padding: 6px; border-bottom: 1px solid #f1f5f9;">${r.landlord}</td></tr>`).join("");

            const showSelfEmployed = selfEmployed.active === "yes";
            const selfEmployedHtml = !showSelfEmployed ? "" : `
                <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                    <h3 style="color: #059669; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">UBER/Lyft (T2125)</h3>
                    <p style="font-size: 12px;"><strong>HST No:</strong> ${selfEmployed.hstNo || "N/A"} | <strong>Access Code:</strong> ${selfEmployed.accessCode || "N/A"}</p>
                    <p style="font-size: 12px;"><strong>Period:</strong> ${selfEmployed.periodFrom || "N/A"} to ${selfEmployed.periodTo || "N/A"}</p>
                    <p style="font-size: 12px; margin-bottom: 12px;"><strong>Total KMs:</strong> ${selfEmployed.totalKms || "0"} | <strong>Business KMs:</strong> ${selfEmployed.businessKms || "0"}</p>
                    <table style="width: 100%; font-size: 12px; border-collapse: collapse; background-color: #f8fafc; border: 1px solid #f1f5f9;">
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9; width: 50%;">Fuel: $${selfEmployed.expenses?.fuel || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Repairs: $${selfEmployed.expenses?.repairs || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Insurance: $${selfEmployed.expenses?.insurance || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Licence: $${selfEmployed.expenses?.license || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Interest: $${selfEmployed.expenses?.interest || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Carwash: $${selfEmployed.expenses?.carwash || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Parking: $${selfEmployed.expenses?.parking || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Tolls: $${selfEmployed.expenses?.tolls || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9; color: #b91c1c;">Tickets: $${selfEmployed.expenses?.tickets || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Phone: $${selfEmployed.expenses?.phone || "0.00"}</td></tr>
                        <tr><td style="padding: 8px;">Supplies: $${selfEmployed.expenses?.supplies || "0.00"}</td><td style="padding: 8px;">Meals: $${selfEmployed.expenses?.meals || "0.00"}</td></tr>
                    </table>
                </div>
            `;

            const showRental = rentalIncome.active === "yes";
            let coOwnerRows = (rentalIncome.coOwners || []).map(o => `<tr><td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${o.name || "N/A"}</td><td style="padding: 6px; border-bottom: 1px solid #e2e8f0;">${o.sin || "N/A"}</td><td style="padding: 6px; border-bottom: 1px solid #e2e8f0; font-weight: bold;">${o.share || "0"}%</td></tr>`).join("");
            if (!coOwnerRows) coOwnerRows = `<tr><td colspan="3" style="padding: 8px; text-align: center; color: #94a3b8;">100% Solely Owned</td></tr>`;

            const rentalHtml = !showRental ? "" : `
                <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                    <h3 style="color: #0284c7; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">Rental Income (T776)</h3>
                    <p style="font-size: 12px;"><strong>Address:</strong> ${rentalIncome.address || "N/A"} | <strong>Gross Income:</strong> $${rentalIncome.grossIncome || "0.00"}</p>
                    <p style="font-size: 12px; color: #0284c7; margin-bottom: 12px;"><strong>Percentage of Property Rented Out:</strong> ${rentalIncome.percentageRented || "100"}%</p>
                    <table style="width: 100%; font-size: 11px; border-collapse: collapse; margin: 12px 0; border: 1px solid #e2e8f0;"><tr style="background-color: #f1f5f9;"><th style="padding: 6px; text-align: left;">Investor</th><th style="padding: 6px; text-align: left;">SIN</th><th style="padding: 6px; text-align: left;">Share %</th></tr>${coOwnerRows}</table>
                    <table style="width: 100%; font-size: 12px; border-collapse: collapse; background-color: #f8fafc; border: 1px solid #f1f5f9;">
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9; width: 50%;">Insurance: $${rentalIncome.expenses?.insurance || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Mortgage Int: $${rentalIncome.expenses?.interest || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Bank/Credit: $${rentalIncome.expenses?.bankCharges || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Office: $${rentalIncome.expenses?.office || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Prof. Fees: $${rentalIncome.expenses?.professional || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Management: $${rentalIncome.expenses?.management || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Repairs: $${rentalIncome.expenses?.repairs || "0.00"}</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">Property Tax: $${rentalIncome.expenses?.propertyTax || "0.00"}</td></tr>
                        <tr><td style="padding: 8px;" colspan="2">Utilities: $${rentalIncome.expenses?.utilities || "0.00"}</td></tr>
                    </table>
                </div>
            `;

            const showCcb = childCareBenefit.active === "yes";
            const ccbHtml = !showCcb ? "" : `
                <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                    <h3 style="color: #6366f1; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">Child Care Benefit (CCB)</h3>
                    <p style="font-size: 12px;"><strong>Marriage Date:</strong> ${childCareBenefit.marriageDate || "N/A"} | <strong>Status Change:</strong> ${childCareBenefit.statusChangeDate || "N/A"}</p>
                    <table style="width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 10px; background-color: #f8fafc; border: 1px solid #f1f5f9;">
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9; width: 60%;">Resident Year:</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-weight: bold;">$${childCareBenefit.worldIncome?.becameResidentYear || "0.00"}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">1 Year Before:</td><td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-weight: bold;">$${childCareBenefit.worldIncome?.oneYearBefore || "0.00"}</td></tr>
                        <tr><td style="padding: 8px;">2 Years Before:</td><td style="padding: 8px; font-weight: bold;">$${childCareBenefit.worldIncome?.twoYearsBefore || "0.00"}</td></tr>
                    </table>
                </div>
            `;

            const organizerHtml = `
                <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 650px; margin: 0 auto; border: 1px solid #e2e8f0;">
                    <h2 style="color: #059669; margin-bottom: 4px;">FiscalX Professional Portal</h2>
                    <p style="font-size: 14px; color: #64748b; margin-top: 0;">Completed Client Tax Organizer (T1 Onboarding)</p>
                    
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${excelDownloadUrl}" target="_blank" style="background-color: #059669; color: #ffffff; text-decoration: none; padding: 14px 28px; font-weight: bold; font-size: 14px; border-radius: 8px;">📊 Download Full Form as Excel (.CSV)</a>
                    </div>
                    
                    <!-- FULL PREVIEW SECTIONS -->
                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">1. Personal Profile</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569; width: 140px;">Name:</td><td style="padding: 8px 0; font-weight: bold;">${personalInfo.fullName || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">9-Digit SIN:</td><td style="padding: 8px 0; font-family: monospace;">${personalInfo.sin || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Email:</td><td style="padding: 8px 0;">${userEmail}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Telephone:</td><td style="padding: 8px 0;">${personalInfo.telephone || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Address:</td><td style="padding: 8px 0;">${personalInfo.address || "N/A"}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; font-weight: bold; color: #475569;">Marital Status:</td><td style="padding: 8px 0; text-transform: capitalize;">${personalInfo.maritalStatus || "N/A"}</td></tr>
                            <tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Spousal Net Inc.:</td><td style="padding: 8px 0; font-weight: bold; color: #059669;">$${personalInfo.spousalIncome || "N/A"}</td></tr>
                        </table>
                    </div>

                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">2. Family Dependents</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
                            <thead><tr style="background-color: #f8fafc; color: #475569;"><th style="padding: 8px;">Name</th><th style="padding: 8px;">SIN</th><th style="padding: 8px;">Birth Date</th><th style="padding: 8px;">Relation</th><th style="padding: 8px;">DTC</th></tr></thead>
                            <tbody>${familyRows || "<tr><td colspan='5' style='padding:6px; text-align:center;'>None</td></tr>"}</tbody>
                        </table>
                    </div>

                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">3. Status & Ontario Properties</h3>
                        <p style="font-size: 13px;"><strong>Immigration:</strong> ${statusInCanada.status || "N/A"} | <strong>Entry Date:</strong> ${statusInCanada.entryDate || "N/A"}</p>
                        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; border: 1px solid #e2e8f0; margin-top: 10px;">
                            <thead><tr style="background-color: #f1f5f9;"><th style="padding: 8px;">Months</th><th style="padding: 8px;">Address</th><th style="padding: 8px;">Landlord/City</th></tr></thead>
                            <tbody>${residencyRows || "<tr><td colspan='3' style='padding:6px; text-align:center;'>None</td></tr>"}</tbody>
                        </table>
                    </div>

                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">4. Milestones & Tax Disclosures</h3>
                        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0; width: 75%;">Auth. Elections Canada?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.electionsCanada || "no").toUpperCase()}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Direct Deposit Changed?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.directDeposit || "no").toUpperCase()}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Paid tuition in a tax year?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.tuition || "no").toUpperCase()}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Contributed toward an RRSP portfolio?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.rrsp || "no").toUpperCase()}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Made any charitable donations?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.charitable || "no").toUpperCase()}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Invested in stocks / Cryptocurrency assets?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.crypto || "no").toUpperCase()}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Paid for child's daycare operations?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.daycare || "no").toUpperCase()}</td></tr>
                            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 10px 0;">Worked from home (T2200 eligible)?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.workFromHome || "no").toUpperCase()}</td></tr>
                            <tr><td style="padding: 10px 0;">Purchased a new home in this tax year?</td><td style="padding: 10px 0; font-weight: bold;">${(milestones.purchasedHome || "no").toUpperCase()}</td></tr>
                        </table>
                    </div>

                    ${selfEmployedHtml}
                    ${rentalHtml}
                    ${ccbHtml}

                    <div style="background-color: #ffffff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                        <h3 style="color: #334155; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; font-size: 15px;">Additional Notes</h3>
                        <p style="font-size: 13px; line-height: 1.5; color: #475569; margin-top: 10px;">${notes || "None provided."}</p>
                    </div>

                    <!-- ATTACHED DOCUMENTS VAULT -->
                    ${documentLinksHtml}
                </div>
            `;

            const sesOrganizerCommand = new SendEmailCommand({
                Source: SENDER_EMAIL, Destination: { ToAddresses: [OFFICE_EMAIL] },
                Message: { Subject: { Charset: "UTF-8", Data: `[CRA Organizer] Complete T1 Onboarding from ${personalInfo.fullName || userEmail}` }, Body: { Html: { Charset: "UTF-8", Data: organizerHtml } } }
            });
            await ses.send(sesOrganizerCommand);

            return { statusCode: 200, headers: headers, body: JSON.stringify({ status: "SUCCESS", message: "Your onboarding organizer and files have been securely compiled and delivered." }) };
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
        return { statusCode: 400, headers: headers, body: JSON.stringify({ status: "ERROR", message: "Failed to parse request data." }) };
    }
};