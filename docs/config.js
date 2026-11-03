// ▼ 배포한 Apps Script 웹앱 주소(/exec)를 따옴표 안에 넣으세요. (README의 배포 방법 참고)
//   예) 'https://script.google.com/macros/s/AKfycb.../exec'
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzX4WeYgWn1YuXg4hdvXVleqINu70qeekhkpt2gG_zKYGqhnFMkFPoYp17_iQuLuTQ/exec';

// 로컬 테스트(node dev-server.js) 때는 자동으로 개발 서버(/exec)를 사용해요.
window.OSAM_API = ['localhost', '127.0.0.1'].includes(location.hostname) ? '/exec' : APPS_SCRIPT_URL;
