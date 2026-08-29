// API Accord Web UI - Client-side Interactions
// Vanilla ES Module, no dependencies

(() => {
  'use strict';

  // ============================================================================
  // Toast Notification System
  // ============================================================================

  let toastContainer = null;

  function ensureToastContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.setAttribute('role', 'region');
      toastContainer.setAttribute('aria-label', 'Notifications');
      toastContainer.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2000;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: 400px;
      `;
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  export function showToast(message, type = 'info', duration = 5000) {
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <span class="toast-message">${escapeHtml(message)}</span>
      <button class="toast-close" aria-label="Dismiss" type="button">&times;</button>
    `;

    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => removeToast(toast));

    container.appendChild(toast);

    // Auto-remove
    const timer = setTimeout(() => removeToast(toast), duration);

    // Pause on hover
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => {
      const remainingTimer = setTimeout(() => removeToast(toast), 1000);
      toast.dataset.removalTimer = remainingTimer;
    });

    return toast;
  }

  function removeToast(toast) {
    if (toast.isConnected) {
      toast.style.animation = 'slideIn 0.2s ease reverse';
      setTimeout(() => toast.remove(), 200);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================================================
  // Table Sorting
  // ============================================================================

  function initTableSorting() {
    document.querySelectorAll('.data-table th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const table = th.closest('.data-table');
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const columnIndex = Array.from(th.parentNode.children).indexOf(th);
        const isAsc = th.classList.toggle('sort-asc');
        th.classList.toggle('sort-desc', !isAsc);

        // Remove sort classes from other headers
        th.parentNode.querySelectorAll('th').forEach((otherTh) => {
          if (otherTh !== th) {
            otherTh.classList.remove('sort-asc', 'sort-desc');
          }
        });

        rows.sort((a, b) => {
          const aText = a.children[columnIndex]?.textContent?.trim() ?? '';
          const bText = b.children[columnIndex]?.textContent?.trim() ?? '';
          const aNum = parseFloat(aText);
          const bNum = parseFloat(bText);
          let comparison = 0;

          if (!isNaN(aNum) && !isNaN(bNum)) {
            comparison = aNum - bNum;
          } else {
            comparison = aText.localeCompare(bText, undefined, { numeric: true });
          }

          return isAsc ? comparison : -comparison;
        });

        rows.forEach((row) => tbody.appendChild(row));
      });

      // Keyboard support
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          th.click();
        }
      });
    });
  }

  // ============================================================================
  // Accordion / Details Toggle
  // ============================================================================

  function initAccordions() {
    document.querySelectorAll('details[data-accordion]').forEach((details) => {
      const summary = details.querySelector('summary');
      if (summary) {
        summary.addEventListener('click', (e) => {
          // Allow default behavior (toggle open)
          setTimeout(() => {
            const isOpen = details.hasAttribute('open');
            details.setAttribute('aria-expanded', isOpen);
          }, 0);
        });
      }
    });
  }

  // ============================================================================
  // Modal Management
  // ============================================================================

  function initModals() {
    // Open modal buttons
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-modal-target]');
      if (trigger) {
        e.preventDefault();
        const modalId = trigger.dataset.modalTarget;
        openModal(modalId);
      }
    });

    // Close modal buttons
    document.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-modal-close]');
      if (closeBtn) {
        e.preventDefault();
        const modalId = closeBtn.dataset.modalClose;
        closeModal(modalId);
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const openModal = document.querySelector('.modal:not([hidden])');
        if (openModal) {
          closeModal(openModal.id);
        }
      }
    });

    // Close on overlay click
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        const modal = e.target.closest('.modal');
        if (modal) closeModal(modal.id);
      }
    });
  }

  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.hidden = false;
      document.body.style.overflow = 'hidden';

      // Focus first focusable element
      const focusable = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable) focusable.focus();

      // Trap focus
      modal.dataset.previousActive = document.activeElement?.id ?? '';
      modal.addEventListener('keydown', trapFocus);
    }
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.hidden = true;
      document.body.style.overflow = '';
      modal.removeEventListener('keydown', trapFocus);

      // Restore focus
      const previousId = modal.dataset.previousActive;
      if (previousId) {
        const prevEl = document.getElementById(previousId);
        if (prevEl) prevEl.focus();
      }
    }
  }

  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const modal = e.currentTarget;
    const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ============================================================================
  // Tab Switching Enhancement (for non-CSS-only tabs)
  // ============================================================================

  function initTabs() {
    document.querySelectorAll('.tabs-nav .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabs = btn.closest('.tabs');
        const tabId = btn.dataset.tab;

        // Update buttons
        tabs.querySelectorAll('.tab-btn').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', b === btn);
        });

        // Update panels
        tabs.querySelectorAll('.tab-panel').forEach((panel) => {
          const isActive = panel.id === `panel-${tabId}`;
          panel.classList.toggle('active', isActive);
          panel.hidden = !isActive;
        });
      });

      // Keyboard navigation
      btn.addEventListener('keydown', (e) => {
        const tabs = btn.closest('.tabs');
        const buttons = Array.from(tabs.querySelectorAll('.tab-btn'));
        const index = buttons.indexOf(btn);

        if (e.key === 'ArrowRight') {
          e.preventDefault();
          buttons[(index + 1) % buttons.length].focus();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          buttons[(index - 1 + buttons.length) % buttons.length].focus();
        } else if (e.key === 'Home') {
          e.preventDefault();
          buttons[0].focus();
        } else if (e.key === 'End') {
          e.preventDefault();
          buttons[buttons.length - 1].focus();
        }
      });
    });
  }

  // ============================================================================
  // Action Buttons (Approve, Request Changes, Start Implementation, etc.)
  // ============================================================================

  function initActionButtons() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      e.preventDefault();
      const action = btn.dataset.action;
      const proposalId = btn.dataset.proposal;
      const contextId = btn.dataset.context;
      const reason = btn.dataset.reason;

      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '처리 중...';

      try {
        const response = await handleAction(action, { proposalId, contextId, reason });
        if (response.ok) {
          showToast(`${action} 완료`, 'success');
          // Optionally refresh the page or update UI
          if (action === 'approve' || action === 'request-changes') {
            setTimeout(() => window.location.reload(), 1000);
          }
        } else {
          const error = await response.json().catch(() => ({ message: 'Unknown error' }));
          showToast(`${action} 실패: ${error.message ?? response.statusText}`, 'error');
        }
      } catch (err) {
        showToast(`${action} 오류: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }

  async function handleAction(action, params) {
    const baseUrl = '/api';
    const endpoints = {
      approve: { method: 'POST', url: `${baseUrl}/proposals/${params.proposalId}/approve` },
      'request-changes': { method: 'POST', url: `${baseUrl}/proposals/${params.proposalId}/request-changes` },
      'start-implementation': { method: 'POST', url: `${baseUrl}/proposals/${params.proposalId}/start-implementation` },
      'view-plan': { method: 'GET', url: `${baseUrl}/proposals/${params.proposalId}/plan` },
      'review-context': { method: 'POST', url: `${baseUrl}/contexts/${params.contextId}/review` },
      escalate: { method: 'POST', url: `${baseUrl}/actions/escalate` },
      snooze: { method: 'POST', url: `${baseUrl}/actions/snooze` },
      'mark-read': { method: 'POST', url: `${baseUrl}/actions/mark-read` }
    };

    const endpoint = endpoints[action];
    if (!endpoint) throw new Error(`Unknown action: ${action}`);

    const body = params.reason ? { reason: params.reason } : {};
    return fetch(endpoint.url, {
      method: endpoint.method,
      headers: { 'Content-Type': 'application/json' },
      body: endpoint.method === 'GET' ? undefined : JSON.stringify(body)
    });
  }

  // ============================================================================
  // Snooze/Mark Read Buttons in Inbox
  // ============================================================================

  function initInboxActions() {
    // Handled by initActionButtons via data-action
  }

  // ============================================================================
  // Keyboard Navigation Enhancements
  // ============================================================================

  function initKeyboardNav() {
    // Make cards with href keyboard accessible
    document.querySelectorAll('.card[href], .quick-start-card[href]').forEach((card) => {
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          card.click();
        }
      });
      // Ensure they have tabindex if not a native link
      if (!card.hasAttribute('tabindex') && card.tagName !== 'A') {
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'link');
      }
    });
  }

  // ============================================================================
  // Initialize All
  // ============================================================================

  function init() {
    // Wait for DOM
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }

    initTableSorting();
    initAccordions();
    initModals();
    initTabs();
    initActionButtons();
    initInboxActions();
    initKeyboardNav();

    // Expose toast globally for server-rendered content
    window.showToast = showToast;

    console.log('[API Accord] Web UI interactions initialized');
  }

  init();
})();