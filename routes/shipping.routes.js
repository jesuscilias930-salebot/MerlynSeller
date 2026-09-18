const router = require('express').Router();
const controller = require('../controllers/shipping.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
router.use(requireUser);
router.get('/store-origin', controller.storeSettings);
router.put('/store-origin', requireRole('owner', 'admin'), controller.saveStoreSettings);
router.get('/postal-codes/:postalCode', async (req, res) => {
  try {
    res.json(await require('../services/envia-postal.service').lookup(req.params.postalCode));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});
router.get('/settings', controller.settings);
router.put('/settings', requireRole('owner', 'admin'), controller.saveSettings);
router.get('/saved', controller.listSaved);
router.get('/customers', controller.customers);
router.post('/saved/addresses', controller.saveAddress);
router.post('/saved/packages', controller.savePackage);
router.delete('/saved/:kind/:id', controller.deleteSaved);
router.get('/shipments', controller.list);
router.post('/quote', controller.quote);
router.post('/generate', requireRole('owner', 'admin'), controller.generate);
module.exports = router;
