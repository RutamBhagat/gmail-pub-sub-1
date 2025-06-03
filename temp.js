const newUuid = crypto.randomUUID();
const emailSubjectOrBodyContent = `spam-test-${newUuid}`;

console.log(emailSubjectOrBodyContent);