const db = require('./database');
const path = require('path');
const fs = require('fs');

class BusinessManager {
    /**
     * Buat bisnis baru
     */
    createBusiness(userId, name, username, password, description = '') {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM businesses WHERE user_id = ? AND LOWER(name) = LOWER(?)',
                [userId, name],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (row) {
                        reject(new Error('BUSINESS_ALREADY_EXISTS'));
                    } else {
                        db.run(
                            'INSERT INTO businesses (user_id, name, username, password, description) VALUES (?, ?, ?, ?, ?)',
                            [userId, name, username, password, description],
                            function(err) {
                                if (err) return reject(err);
                                resolve({ 
                                    id: this.lastID, 
                                    user_id: userId, 
                                    name: name,
                                    username: username,
                                    description: description
                                });
                            }
                        );
                    }
                }
            );
        });
    }

    /**
     * Get bisnis by user
     */
    getBusinessesByUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM businesses WHERE user_id = ? ORDER BY created_at DESC',
                [userId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get bisnis by name
     */
    getBusinessByName(userId, name) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM businesses WHERE user_id = ? AND LOWER(name) = LOWER(?)',
                [userId, name],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
    }

    /**
     * Get business by name across all users (global lookup)
     */
    getBusinessByNameAny(name) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM businesses WHERE LOWER(name) = LOWER(?)',
                [name],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
    }

    /**
     * Verify business credentials
     */
    verifyBusinessCredentials(userId, name, username, password) {
        return new Promise((resolve, reject) => {
            // Allow verification across businesses (so other users can login to a business if they have credentials)
            db.get(
                'SELECT * FROM businesses WHERE LOWER(name) = LOWER(?) AND username = ? AND password = ?',
                [name, username, password],
                (err, row) => {
                    if (err) return reject(err);
                    // Return the matched business row (so caller can obtain business id)
                    resolve(row || null);
                }
            );
        });
    }

    /**
     * Start business session
     */
    startBusinessSession(userId, businessId) {
        return new Promise((resolve, reject) => {
            db.run(
                'INSERT OR REPLACE INTO business_sessions (user_id, business_id, started_at) VALUES (?, ?, datetime("now"))',
                [userId, businessId],
                function(err) {
                    if (err) return reject(err);
                    resolve({ userId, businessId });
                }
            );
        });
    }

    /**
     * End business session
     */
    endBusinessSession(userId) {
        return new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM business_sessions WHERE user_id = ?',
                [userId],
                function(err) {
                    if (err) return reject(err);
                    resolve(true);
                }
            );
        });
    }

    /**
     * Get active business session
     */
    getActiveSession(userId) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT bs.*, b.name as business_name, b.description 
                 FROM business_sessions bs 
                 JOIN businesses b ON bs.business_id = b.id 
                 WHERE bs.user_id = ?`,
                [userId],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
    }

    /**
     * Add material
     */
    addMaterial(businessId, name, unitPrice, packPrice = null, perPack = null) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM materials WHERE business_id = ? AND LOWER(name) = LOWER(?)',
                [businessId, name],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (row) {
                        reject(new Error('MATERIAL_ALREADY_EXISTS'));
                    } else {
                        db.run(
                            'INSERT INTO materials (business_id, name, unit_price, pack_price, per_pack) VALUES (?, ?, ?, ?, ?)',
                            [businessId, name, unitPrice, packPrice, perPack],
                            function(err) {
                                if (err) return reject(err);
                                resolve({ 
                                    id: this.lastID, 
                                    business_id: businessId, 
                                    name: name,
                                    unit_price: unitPrice,
                                    pack_price: packPrice,
                                    per_pack: perPack
                                });
                            }
                        );
                    }
                }
            );
        });
    }

    /**
     * Get all materials for business
     */
    getMaterials(businessId) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM materials WHERE business_id = ? ORDER BY name',
                [businessId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get material by name
     */
    getMaterialByName(businessId, name) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM materials WHERE business_id = ? AND LOWER(name) = LOWER(?)',
                [businessId, name],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
    }

    /**
     * Update material fields (unit_price, pack_price, per_pack)
     * updates: { unit_price?, pack_price?, per_pack? }
     */
    updateMaterial(businessId, name, updates) {
        return new Promise((resolve, reject) => {
            const fields = [];
            const values = [];
            if (updates.unit_price !== undefined) {
                fields.push('unit_price = ?'); values.push(updates.unit_price);
            }
            if (updates.pack_price !== undefined) {
                fields.push('pack_price = ?'); values.push(updates.pack_price);
            }
            if (updates.per_pack !== undefined) {
                fields.push('per_pack = ?'); values.push(updates.per_pack);
            }

            if (fields.length === 0) return resolve(false);

            values.push(businessId, name);
            const sql = `UPDATE materials SET ${fields.join(', ')} WHERE business_id = ? AND LOWER(name) = LOWER(?)`;
            db.run(sql, values, function(err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            });
        });
    }

    /**
     * Delete material by name
     */
    deleteMaterialByName(businessId, name) {
        return new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM materials WHERE business_id = ? AND LOWER(name) = LOWER(?)',
                [businessId, name],
                function(err) {
                    if (err) return reject(err);
                    resolve(this.changes > 0);
                }
            );
        });
    }

    /**
     * Delete all materials for a business
     */
    deleteAllMaterials(businessId) {
        return new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM materials WHERE business_id = ?',
                [businessId],
                function(err) {
                    if (err) return reject(err);
                    resolve(true);
                }
            );
        });
    }

    /**
     * Calculate cost from materials
     */
    calculateCost(materials) {
        let totalCost = 0;
        materials.forEach(m => {
            const unit = (m.unit_price === null || m.unit_price === undefined) ? 0 : Number(m.unit_price);
            const qty = (m.quantity === null || m.quantity === undefined) ? 0 : Number(m.quantity);
            totalCost += unit * qty;
        });
        return totalCost;
    }

    /**
     * Add price tier
     */
    addPriceTier(businessId, price) {
        return new Promise((resolve, reject) => {
            // Check if price already exists
            db.get(
                'SELECT * FROM price_tiers WHERE business_id = ? AND price = ?',
                [businessId, price],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (row) {
                        reject(new Error('PRICE_ALREADY_EXISTS'));
                    } else {
                        db.run(
                            'INSERT INTO price_tiers (business_id, price) VALUES (?, ?)',
                            [businessId, price],
                            function(err) {
                                if (err) return reject(err);
                                resolve({ 
                                    id: this.lastID, 
                                    business_id: businessId, 
                                    price: price
                                });
                            }
                        );
                    }
                }
            );
        });
    }

    /**
     * Get all price tiers for business
     */
    getPriceTiers(businessId) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM price_tiers WHERE business_id = ? ORDER BY price ASC',
                [businessId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });
    }

    /**
     * Add empty bouquet price (size + price)
     */
    addEmptyBouquet(businessId, size, price) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM empty_bouquets WHERE business_id = ? AND LOWER(size) = LOWER(?)',
                [businessId, size],
                (err, row) => {
                    if (err) return reject(err);
                    if (row) return reject(new Error('EMPTY_BOUQUET_ALREADY_EXISTS'));
                    db.run(
                        'INSERT INTO empty_bouquets (business_id, size, price) VALUES (?, ?, ?)',
                        [businessId, size, price],
                        function(err) {
                            if (err) return reject(err);
                            resolve({ id: this.lastID, business_id: businessId, size, price });
                        }
                    );
                }
            );
        });
    }

    /**
     * Get all empty bouquets for a business
     */
    getEmptyBouquets(businessId) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM empty_bouquets WHERE business_id = ? ORDER BY created_at DESC',
                [businessId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get empty bouquet by size
     */
    getEmptyBouquetBySize(businessId, size) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM empty_bouquets WHERE business_id = ? AND LOWER(size) = LOWER(?)',
                [businessId, size],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row || null);
                }
            );
        });
    }

    /**
     * Update empty bouquet price
     */
    updateEmptyBouquet(id, updates) {
        return new Promise((resolve, reject) => {
            const fields = [];
            const values = [];
            if (updates.size !== undefined) { fields.push('size = ?'); values.push(updates.size); }
            if (updates.price !== undefined) { fields.push('price = ?'); values.push(updates.price); }

            if (fields.length === 0) return resolve(false);

            values.push(id);
            const sql = `UPDATE empty_bouquets SET ${fields.join(', ')} WHERE id = ?`;
            db.run(sql, values, function(err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            });
        });
    }

    /**
     * Delete empty bouquet
     */
    deleteEmptyBouquet(id) {
        return new Promise((resolve, reject) => {
            db.run('DELETE FROM empty_bouquets WHERE id = ?', [id], function(err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            });
        });
    }

    /**
     * Delete price tier
     */
    deletePriceTier(priceTierId) {
        return new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM price_tiers WHERE id = ?',
                [priceTierId],
                function(err) {
                    if (err) return reject(err);
                    resolve(true);
                }
            );
        });
    }

    /**
     * Suggest selling price based on cost and available price tiers
     */
    async suggestSellingPrice(businessId, cost) {
        const priceTiers = await this.getPriceTiers(businessId);
        
        if (priceTiers.length === 0) {
            // Default price tiers if none configured
            const defaultPrices = [1000, 5000, 6000, 8000, 10000, 12000, 15000, 20000];
            const minPrice = cost * 1.3;
            const suggested = defaultPrices.find(p => p >= minPrice);
            return suggested || Math.ceil(minPrice / 1000) * 1000;
        }
        
        // Find the appropriate price range (dengan margin minimal 30%)
        const minPrice = cost * 1.3;
        const suggested = priceTiers.find(pt => pt.price >= minPrice);
        
        if (suggested) {
            return suggested.price;
        }
        
        // If cost exceeds all tiers, suggest next tier above highest
        const highestTier = priceTiers[priceTiers.length - 1].price;
        return Math.ceil(minPrice / 1000) * 1000;
    }

    /**
     * Add catalog item
     */
    addCatalog(businessId, name, price, imagePath = null, productionCost = null, productionMaterials = null) {
        return new Promise((resolve, reject) => {
            const prodMatJson = productionMaterials ? JSON.stringify(productionMaterials) : null;
            db.run(
                'INSERT INTO catalogs (business_id, name, price, image_path, production_cost, production_materials) VALUES (?, ?, ?, ?, ?, ?)',
                [businessId, name, price, imagePath, productionCost, prodMatJson],
                function(err) {
                    if (err) return reject(err);
                    resolve({ 
                        id: this.lastID, 
                        business_id: businessId, 
                        name: name,
                        price: price,
                        image_path: imagePath,
                        production_cost: productionCost,
                        production_materials: productionMaterials
                    });
                }
            );
        });
    }

    /**
     * Get catalog by name
     */
    getCatalogByName(businessId, name) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM catalogs WHERE business_id = ? AND LOWER(name) = LOWER(?)',
                [businessId, name],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    try { row.production_materials = row.production_materials ? JSON.parse(row.production_materials) : null; } catch (e) { row.production_materials = null; }
                    resolve(row);
                }
            );
        });
    }

    /**
     * Update catalog item (name, price, image_path)
     * updates: { name?, price?, image_path? }
     */
    updateCatalog(catalogId, updates) {
        return new Promise((resolve, reject) => {
            const fields = [];
            const values = [];
            if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
            if (updates.price !== undefined) { fields.push('price = ?'); values.push(updates.price); }
            if (updates.image_path !== undefined) { fields.push('image_path = ?'); values.push(updates.image_path); }
            if (updates.production_cost !== undefined) { fields.push('production_cost = ?'); values.push(updates.production_cost); }
            if (updates.production_materials !== undefined) { fields.push('production_materials = ?'); values.push(updates.production_materials ? JSON.stringify(updates.production_materials) : null); }

            if (fields.length === 0) return resolve(false);

            values.push(catalogId);
            const sql = `UPDATE catalogs SET ${fields.join(', ')} WHERE id = ?`;
            db.run(sql, values, function(err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            });
        });
    }

    /**
     * Delete all catalogs for a business (and remove images)
     */
    deleteAllCatalogs(businessId) {
        return new Promise((resolve, reject) => {
            db.all('SELECT * FROM catalogs WHERE business_id = ?', [businessId], (err, rows) => {
                if (err) return reject(err);
                rows.forEach(row => {
                    if (row.image_path && fs.existsSync(row.image_path)) {
                        try { fs.unlinkSync(row.image_path); } catch (e) { /* ignore */ }
                    }
                });
                db.run('DELETE FROM catalogs WHERE business_id = ?', [businessId], function(err) {
                    if (err) return reject(err);
                    resolve(true);
                });
            });
        });
    }

    /**
     * Delete all price tiers for a business
     */
    deleteAllPriceTiers(businessId) {
        return new Promise((resolve, reject) => {
            db.run('DELETE FROM price_tiers WHERE business_id = ?', [businessId], function(err) {
                if (err) return reject(err);
                resolve(true);
            });
        });
    }

    /**
     * Get all catalogs
     */
    getCatalogs(businessId) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM catalogs WHERE business_id = ? ORDER BY created_at DESC',
                [businessId],
                (err, rows) => {
                    if (err) return reject(err);
                    const parsed = (rows || []).map(r => {
                        try { r.production_materials = r.production_materials ? JSON.parse(r.production_materials) : null; } catch (e) { r.production_materials = null; }
                        return r;
                    });
                    resolve(parsed);
                }
            );
        });
    }

    /**
     * Get catalogs filtered by exact price
     */
    getCatalogsByPrice(businessId, price) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM catalogs WHERE business_id = ? AND price = ? ORDER BY created_at DESC',
                [businessId, price],
                (err, rows) => {
                    if (err) return reject(err);
                    const parsed = (rows || []).map(r => {
                        try { r.production_materials = r.production_materials ? JSON.parse(r.production_materials) : null; } catch (e) { r.production_materials = null; }
                        return r;
                    });
                    resolve(parsed);
                }
            );
        });
    }

    /**
     * Delete catalog item
     */
    deleteCatalog(catalogId) {
        return new Promise((resolve, reject) => {
            // Get catalog first to delete image file
            db.get(
                'SELECT * FROM catalogs WHERE id = ?',
                [catalogId],
                (err, row) => {
                    if (err) return reject(err);
                    
                    if (row && row.image_path && fs.existsSync(row.image_path)) {
                        try {
                            fs.unlinkSync(row.image_path);
                        } catch (e) {
                            console.error('Error deleting image:', e);
                        }
                    }
                    
                    db.run(
                        'DELETE FROM catalogs WHERE id = ?',
                        [catalogId],
                        function(err) {
                            if (err) return reject(err);
                            resolve(true);
                        }
                    );
                }
            );
        });
    }

    /**
     * Add business expense
     */
    addExpense(businessId, description, amount) {
        return new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO business_expenses (business_id, description, amount, is_recorded) VALUES (?, ?, ?, 0)',
                [businessId, description, amount],
                function(err) {
                    if (err) return reject(err);
                    resolve({ 
                        id: this.lastID, 
                        business_id: businessId, 
                        description: description,
                        amount: amount,
                        is_recorded: 0
                    });
                }
            );
        });
    }

    /**
     * Get all expenses
     */
    getExpenses(businessId, includeRecorded = true) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT * FROM business_expenses WHERE business_id = ?';
            if (!includeRecorded) {
                query += ' AND is_recorded = 0';
            }
            query += ' ORDER BY created_at DESC';
            
            db.all(query, [businessId], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    /**
     * Mark expense as recorded
     */
    markExpenseAsRecorded(expenseId) {
        return new Promise((resolve, reject) => {
            db.run(
                'UPDATE business_expenses SET is_recorded = 1 WHERE id = ?',
                [expenseId],
                function(err) {
                    if (err) return reject(err);
                    resolve(true);
                }
            );
        });
    }

    /**
     * Add business income
     */
    addIncome(businessId, description, amount) {
        return new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO business_incomes (business_id, description, amount) VALUES (?, ?, ?)',
                [businessId, description, amount],
                function(err) {
                    if (err) return reject(err);
                    resolve({ 
                        id: this.lastID, 
                        business_id: businessId, 
                        description: description,
                        amount: amount
                    });
                }
            );
        });
    }

    /**
     * Get all incomes
     */
    getIncomes(businessId) {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM business_incomes WHERE business_id = ? ORDER BY created_at DESC',
                [businessId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get business statistics
     */
    getBusinessStats(businessId) {
        return new Promise((resolve, reject) => {
            Promise.all([
                this.getIncomes(businessId),
                this.getExpenses(businessId),
                this.getMaterials(businessId),
                this.getCatalogs(businessId)
            ]).then(([incomes, expenses, materials, catalogs]) => {
                const totalIncome = incomes.reduce((sum, i) => sum + i.amount, 0);
                const totalExpense = expenses.reduce((sum, e) => sum + e.amount, 0);
                const unrecordedExpenses = expenses.filter(e => e.is_recorded === 0);
                
                resolve({
                    totalIncome,
                    totalExpense,
                    profit: totalIncome - totalExpense,
                    materialsCount: materials.length,
                    catalogsCount: catalogs.length,
                    unrecordedExpensesCount: unrecordedExpenses.length
                });
            }).catch(reject);
        });
    }
}

module.exports = new BusinessManager();
