/* group-inquiry — matches form fields in groups.html (name, email, location, group_size, dates, message). */
const { inquiryHandler } = require("./lib/inquiry");

exports.handler = inquiryHandler({
  kind: "Group booking",
  required: ["name", "email", "location", "group_size", "dates"],
  labels: {
    name: "Name",
    email: "Email",
    location: "Location",
    group_size: "Group size",
    dates: "Dates",
    message: "Message"
  }
});
