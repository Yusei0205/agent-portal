import { useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { ContextChips, ContextPicker, sendFiles } from '../../components/ContextPicker.jsx';
import { Button, useUi } from '../../components/ui.jsx';
import { CommandMenu, SLASH_COMMANDS } from './CommandMenu.jsx';
import { CommandPickerModal } from './CommandPickerModal.jsx';
import { CommandResultView } from './CommandResultView.jsx';

/* ---------------- Composer ---------------- */

/**
 * Composer with slash-command support.
 *
 * Typing "/" opens a command menu filtered as the user types.
 * Keyboard: ↑/↓ to navigate, Enter to select, Escape to dismiss.
 * Selecting a command POSTs it. Commands that return type==='options' open a picker modal.
 * Result messages appear above the composer; normal messages send as before.
 */
export function Composer({ workflow, canEdit, onSent, onWorkflowChange }) {
  const { project } = useProject();
  const { toast } = useUi();
  const [text, setText] = useState('');
  const [attached, setAttached] = useState([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  // Slash-command state
  const [menuItems, setMenuItems] = useState([]);   // filtered SLASH_COMMANDS
  const [menuActive, setMenuActive] = useState(0);  // keyboard-highlighted index
  const [cmdResult, setCmdResult] = useState(null); // CommandResult | { _error: true, text }
  const [pickerResult, setPickerResult] = useState(null); // CommandResult with type==='options'
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState(null);
  const textareaRef = useRef(null);

  if (!canEdit) return null;

  const running = workflow.status === 'running';

  // Whether the current text looks like a slash-command (starts with /)
  const isSlashInput = text.startsWith('/');

  // Recompute menu whenever text changes
  const updateMenu = (val) => {
    if (!val.startsWith('/')) {
      setMenuItems([]);
      setMenuActive(0);
      return;
    }
    // Only show the menu while the user is still typing the command name (no space yet, or empty arg).
    // Once an argument is typed we hide the menu — they know what they're doing.
    const spaceIdx = val.indexOf(' ');
    if (spaceIdx > 0) {
      // They've typed an argument; hide the menu.
      setMenuItems([]);
      setMenuActive(0);
      return;
    }
    const prefix = val.toLowerCase();
    const filtered = SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
    setMenuItems(filtered);
    setMenuActive(0);
  };

  const handleChange = (e) => {
    const val = e.target.value;
    setText(val);
    updateMenu(val);
  };

  // POST /api/workflows/:id/command
  const runCommand = async (commandText) => {
    setBusy(true);
    setCmdResult(null);
    try {
      const result = await api.post(`/api/workflows/${workflow.id}/command`, { command: commandText });
      if (result.type === 'options') {
        // Parse the command name from the text so the picker can build the follow-up command.
        const spaceIdx = commandText.indexOf(' ');
        const cmdName = (spaceIdx < 0 ? commandText : commandText.slice(0, spaceIdx)).toLowerCase();
        // Open the picker modal — don't show a text result yet.
        setPickerResult({ ...result, _cmdName: cmdName });
        setPickerError(null);
      } else {
        setCmdResult(result);
        // If the command changed a setting, propagate the updated workflow to the parent.
        if (result.workflow) onWorkflowChange(result.workflow);
      }
    } catch (e) {
      setCmdResult({ _error: true, text: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Called when the user picks an option from the picker modal.
  const handlePickerSelect = async (option) => {
    // Build the follow-up command: /cmdname <optionId>
    // Use 'default' for the empty-id option (project default engine/agent).
    const cmdName = pickerResult._cmdName || '';
    const arg = option.id === '' ? 'default' : option.id;
    const commandText = `${cmdName} ${arg}`;
    setPickerBusy(true);
    setPickerError(null);
    try {
      const result = await api.post(`/api/workflows/${workflow.id}/command`, { command: commandText });
      setPickerResult(null);
      setCmdResult(result);
      if (result.workflow) onWorkflowChange(result.workflow);
    } catch (e) {
      setPickerError(e);
    } finally {
      setPickerBusy(false);
    }
  };

  // Select a command from the menu (fills textarea).
  const selectMenuItem = (item) => {
    // For commands that take an arg, fill just the name + space so the user can type an arg.
    // For arg-less commands, fill the full name and submit immediately.
    const argless = ['/help', '/context', '/usage', '/status', '/stop', '/resume'];
    if (argless.includes(item.name)) {
      setText('');
      setMenuItems([]);
      runCommand(item.name);
    } else {
      const newText = item.name + ' ';
      setText(newText);
      setMenuItems([]);
      textareaRef.current?.focus();
    }
  };

  // Submit handler — if it's a slash-command, run it; otherwise send as a normal message.
  const send = async () => {
    if (!text.trim() || busy) return;
    if (text.trim().startsWith('/')) {
      const commandText = text.trim();
      setText('');
      setMenuItems([]);
      await runCommand(commandText);
      return;
    }
    // Normal message path.
    setBusy(true);
    try {
      const context = await sendFiles(workflow.id, attached);
      await api.post(`/api/workflows/${workflow.id}/messages`, { body: text, context });
      setText('');
      setAttached([]);
      setCmdResult(null);
      toast(running ? 'Queued for the next step' : 'Instruction sent; the session is running again');
      onSent();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e) => {
    // Menu navigation
    if (menuItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuActive((i) => Math.min(i + 1, menuItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuActive((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        selectMenuItem(menuItems[menuActive]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuItems([]);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  // Derive picker modal title from the command name
  const pickerTitle = pickerResult?._cmdName
    ? { '/model': 'Choose a model', '/agent': 'Choose a lead agent', '/engine': 'Choose an engine' }[pickerResult._cmdName] || 'Choose an option'
    : 'Choose an option';

  // Extract intro text (everything up to the blank line before list, or the full text).
  const pickerIntro = pickerResult?.text
    ? pickerResult.text.split('\n\nUse')[0].split('\n\nuse')[0]
    : '';

  return (
    <div className="ws-composer-wrap">
      {/* Live region for screen readers to announce command results */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {cmdResult?.text ?? ''}
      </div>

      {cmdResult ? (
        <CommandResultView result={cmdResult} onClose={() => setCmdResult(null)} />
      ) : null}

      <form
        className="ws-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <ContextChips items={attached} onRemove={(i) => setAttached((a) => a.filter((_, j) => j !== i))} />

        {/* Command menu floats above the textarea */}
        <div className="cmd-menu-wrap">
          {menuItems.length > 0 ? (
            <CommandMenu
              items={menuItems}
              activeIndex={menuActive}
              onSelect={selectMenuItem}
              anchorRef={textareaRef}
            />
          ) : null}
          <textarea
            ref={textareaRef}
            className="input"
            rows={2}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            aria-label="Instruction for the agents, or a slash command"
            aria-autocomplete={menuItems.length ? 'list' : undefined}
            aria-controls={menuItems.length ? 'cmd-menu-list' : undefined}
            aria-activedescendant={menuItems.length ? `cmd-menu-item-${menuActive}` : undefined}
            aria-expanded={menuItems.length > 0 ? 'true' : 'false'}
            role={menuItems.length ? 'combobox' : undefined}
            placeholder={
              running
                ? 'Added to the next step — or type / for a command.'
                : 'Tell the agents what to do — or type / for a command.'
            }
          />
        </div>

        <div className="ws-composer-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => setPicking(true)}
            title="Attach documents, files, notes or links to this instruction"
            disabled={isSlashInput}
          >
            Attach context
          </Button>
          <span className="muted small push">Ctrl+Enter to send</span>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!text.trim()}
          >
            {isSlashInput ? 'Run command' : running ? 'Queue instruction' : 'Send and continue'}
          </Button>
        </div>
        {picking ? (
          <ContextPicker
            projectId={project.id}
            excludeSessionId={workflow.id}
            onAdd={(item) => setAttached((a) => [...a, item])}
            onClose={() => setPicking(false)}
          />
        ) : null}
      </form>

      {pickerResult ? (
        <CommandPickerModal
          title={pickerTitle}
          intro={pickerIntro}
          options={pickerResult.options}
          onSelect={handlePickerSelect}
          onClose={() => { setPickerResult(null); textareaRef.current?.focus(); }}
          busy={pickerBusy}
          error={pickerError}
        />
      ) : null}
    </div>
  );
}
