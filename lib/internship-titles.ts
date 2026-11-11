const internship = /\b(?:intern(?:s|ships?)?|co[-\s]?op|student placement)\b/i;
const nonTechnical = /\b(?:sales|marketing|accounting|recruiting|human resources|loss prevention|physical security|campus security|business development)\b/i;
const technical = /\b(?:swe|software|developers?|full[\s-]?stack|front[\s-]?end|back[\s-]?end|programmers?|information technology|information systems|it|help[\s-]?desk|service[\s-]?desk|technical support|desktop support|network|systems (?:engineer\w*|admin\w*|analyst\w*)|infrastructure|cloud|devops|devsecops|site reliability|cyber[\s-]?sec(?:urity)?|cyber|information security|infosec|security (?:engineer\w*|analyst\w*|operations|intern\w*)|soc|application security|penetration testing|digital forensics)\b/i;

export function isTechnicalInternship(title: string, internshipHint = false) {
  const normalized = title.normalize("NFKC").replace(/[‐‑‒–—]/g, "-");
  return (internshipHint || internship.test(normalized)) && technical.test(normalized) && !nonTechnical.test(normalized);
}
