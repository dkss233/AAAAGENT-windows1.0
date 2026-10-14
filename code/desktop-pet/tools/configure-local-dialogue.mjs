import { configureLocalDialogue, parseLocalDialogueArguments } from './local-dialogue-config.mjs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node tools/configure-local-dialogue.mjs --config PATH --model INSTALLED_ID [--url http://127.0.0.1:11435/v1] [--context 16384 --input 12000 --output 768] [--timeout-ms 120000] [--temperature 0.7] [--reasoning none|server]\nDisable: node tools/configure-local-dialogue.mjs --config PATH --off\nOnly foreground dialogue changes. Memory, summary, admission, perception and speech keep their current configuration and may use cloud services. The server context must match --context. This command does not install models, start a server or send requests.');
} else {
  const { configPath, selection } = parseLocalDialogueArguments(args);
  const backup = await configureLocalDialogue(configPath, selection);
  console.log(selection ? 'Local foreground dialogue saved. Start the selected local model service before restarting the desktop.' : 'Local dialogue override removed. Restart the desktop to use the existing cloud dialogue configuration.');
  console.log('Memory, summary, admission, perception and speech keep their current configuration and may use cloud services. Activation status preserved.');
  console.log('Backup files: ' + backup.config + ' and ' + backup.activation);
}
