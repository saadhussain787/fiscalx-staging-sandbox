import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const s3 = new S3Client({ region: "ca-central-1" });
const ses = new SESClient({ region: "ca-central-1" });

const BUCKET_NAME = "fiscalx-document-vault-303238378489";

const SENDER_EMAIL = "arfa787.sa@gmail.com"; 
const OFFICE_EMAIL = "arfa787.sa@gmail.com"; 

export const handler = async (event) => {
    console.log("Incoming Event Payload:", JSON.stringify(event));

    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    };

    if (event.requestContext && event.requestContext.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ message: "CORS preflight successful" })
        };
    }

    try {
        const data = JSON.parse(event.body || "{}");

        if (data.action === "getUploadUrl") {
            const fileName = data.fileName;
            const fileType = data.fileType;
            const userEmail = data.userEmail;

            const fileKey = `clients/${userEmail}/${Date.now()}-${fileName}`;

            const command = new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: fileKey,
                ContentType: fileType
            });

            const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({
                    status: "SUCCESS",
                    uploadUrl: uploadUrl,
                    fileKey: fileKey
                })
            };
        }

        if (data.action === "notifyUploadComplete") {
            const fileKey = data.fileKey;
            const userEmail = data.userEmail;
            const fileName = fileKey.split("/").pop(); 

            const downloadCommand = new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: fileKey
            });
            const downloadUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 86400 });

            const emailHtml = `
                <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                    <h2 style="color: #4f46e5; margin-bottom: 4px;">FiscalX Document Vault</h2>
                    <p style="font-size: 14px; color: #64748b; margin-top: 0;">Automated Client Upload Notification</p>
                    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                    
                    <p style="font-size: 15px; leading-height: 1.5;">Hello Administrative Team,</p>
                    <p style="font-size: 15px; leading-height: 1.5;">A client has successfully uploaded a new document to their secure private folder:</p>
                    
                    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <tr>
                            <td style="padding: 12px; font-weight: bold; color: #475569; width: 140px; border-bottom: 1px solid #e2e8f0;">Client Email:</td>
                            <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${userEmail}</td>
                        </tr>
                        <tr>
                            <td style="padding: 12px; font-weight: bold; color: #475569; border-bottom: 1px solid #e2e8f0;">File Name:</td>
                            <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${fileName.substring(13)}</td>
                        </tr>
                        <tr>
                            <td style="padding: 12px; font-weight: bold; color: #475569;">Vault Path:</td>
                            <td style="padding: 12px; font-family: monospace; color: #64748b;">${fileKey}</td>
                        </tr>
                    </table>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${downloadUrl}" target="_blank" style="background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 14px 28px; font-weight: bold; font-size: 14px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.1);">
                            Download Document Securely
                        </a>
                        <p style="font-size: 11px; color: #94a3b8; margin-top: 14px;">This download link is temporary and will expire in 24 hours for security.</p>
                    </div>
                    
                    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                    <p style="font-size: 12px; color: #94a3b8; text-align: center;">&copy; 2026 FiscalX Professional Corporation. Secure Serverless Delivery.</p>
                </div>
            `;

            const sesCommand = new SendEmailCommand({
                Source: SENDER_EMAIL,
                Destination: { ToAddresses: [OFFICE_EMAIL] },
                Message: {
                    Subject: { Charset: "UTF-8", Data: `[Vault Alert] New Client Upload from ${userEmail}` },
                    Body: { Html: { Charset: "UTF-8", Data: emailHtml } }
                }
            });

            await ses.send(sesCommand);

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({
                    status: "SUCCESS",
                    message: "Receptionist notification dispatched successfully."
                })
            };
        }

        const fullName = data.fullName;
        const email = data.email;
        const service = data.service;
        const message = data.message;

        console.log(`Intake Received - Name: ${fullName}, Email: ${email}, Service: ${service}, Message: ${message}`);

        const intakeHtml = `
            <div style="font-family: sans-serif; padding: 20px; color: #1e293b; background-color: #f8fafc; border-radius: 16px; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0;">
                <h2 style="color: #0284c7; margin-bottom: 4px;">FiscalX Intake Portal</h2>
                <p style="font-size: 14px; color: #64748b; margin-top: 0;">New Consultation Request Received</p>
                <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                
                <p style="font-size: 15px;">Hello Advisory Team,</p>
                <p style="font-size: 15px;">A new visitor has submitted a consultation request from your website:</p>
                
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <tr>
                        <td style="padding: 12px; font-weight: bold; color: #475569; width: 140px; border-bottom: 1px solid #e2e8f0;">Full Name:</td>
                        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${fullName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px; font-weight: bold; color: #475569; border-bottom: 1px solid #e2e8f0;">Email:</td>
                        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;"><a href="mailto:${email}">${email}</a></td>
                    </tr>
                    <tr>
                        <td style="padding: 12px; font-weight: bold; color: #475569; border-bottom: 1px solid #e2e8f0;">Requested Service:</td>
                        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-transform: capitalize;">${service}</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px; font-weight: bold; color: #475569; vertical-align: top;">Message:</td>
                        <td style="padding: 12px; color: #475569; line-height: 1.5;">${message || "No additional context provided."}</td>
                    </tr>
                </table>
                
                <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                <p style="font-size: 12px; color: #94a3b8; text-align: center;">&copy; 2026 FiscalX Professional Corporation. Secure Serverless Delivery.</p>
            </div>
        `;

        const sesIntakeCommand = new SendEmailCommand({
            Source: SENDER_EMAIL,
            Destination: { ToAddresses: [OFFICE_EMAIL] },
            Message: {
                Subject: { Charset: "UTF-8", Data: `[New Lead] Consultation Request from ${fullName}` },
                Body: { Html: { Charset: "UTF-8", Data: intakeHtml } }
            }
        });

        await ses.send(sesIntakeCommand);

        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                status: "SUCCESS",
                message: `Thank you, ${fullName}. Your financial advisory request has been queued.`
            })
        };

    } catch (error) {
        console.error("Error processing request:", error);
        return {
            statusCode: 400,
            headers: headers,
            body: JSON.stringify({
                status: "ERROR",
                message: "Failed to parse request data."
            })
        };
    }
};