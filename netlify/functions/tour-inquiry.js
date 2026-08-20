/* tour-inquiry — matches form fields in tours.html (name, email, tour, guests, date, message). */
const { inquiryHandler } = require("./lib/inquiry");

exports.handler = inquiryHandler({
  kind: "Tour",
  required: ["name", "email", "tour", "guests", "date"],
  labels: {
    name: "Name",
    email: "Email",
    tour: "Tour",
    guests: "Travellers",
    date: "Preferred start date",
    message: "Message"
  }
});
