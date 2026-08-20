/* contact — matches form fields in contact.html (name, email, subject, message). */
const { inquiryHandler } = require("./lib/inquiry");

exports.handler = inquiryHandler({
  kind: "Contact",
  required: ["name", "email", "subject", "message"],
  labels: {
    name: "Name",
    email: "Email",
    subject: "Subject",
    message: "Message"
  }
});
