// Deferred: runs after the form exists. </script> in a string stays inside the script.
const marker = "</script>";
document.querySelector("form").dataset.ready = marker.length > 0 ? "yes" : "no";
